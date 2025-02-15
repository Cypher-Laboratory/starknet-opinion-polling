// pollManager.ts
import { Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import { getDb } from './database';
import { config } from './config';

interface PollData {
  id: number;
  question: string;
  options: string[];
  end_time: string;
  created_at: string;
  is_active: boolean;
}

interface PollOption {
  id: number;
  option_text: string;
  vote_count: number;
}

interface PollResults {
  question: string;
  options: PollOption[];
  total_votes: number;
  is_active: boolean;
  end_time: string;
}

// Create a new poll
export async function createPoll(
  ctx: Context,
  question: string,
  options: string[],
  duration: number
): Promise<PollData> {
  const db = getDb();

  // Validate input
  if (!question.trim()) {
    throw new Error('Question cannot be empty');
  }

  if (options.length < 2) {
    throw new Error('Please provide at least 2 options for the poll');
  }

  if (options.length > config.polls.maxOptions) {
    throw new Error(`Maximum ${config.polls.maxOptions} options allowed`);
  }

  if (duration < config.polls.minDuration) {
    throw new Error(`Minimum duration is ${config.polls.minDuration} minutes`);
  }

  if (duration > config.polls.maxDuration) {
    throw new Error(`Maximum duration is ${config.polls.maxDuration} minutes`);
  }

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      // Insert the poll
      db.run(
        `INSERT INTO polls (
          channel_id,
          creator_id,
          question,
          end_time,
          is_active
        ) VALUES (?, ?, ?, datetime('now', '+' || ? || ' minutes'), 1)`,
        [
          ctx.chat?.id.toString(),
          ctx.from?.id.toString(),
          question,
          duration.toString()
        ],
        function(err) {
          if (err) {
            db.run('ROLLBACK');
            reject(err);
            return;
          }

          const pollId = this.lastID;

          // Insert all options
          const insertPromises = options.map((option) => {
            return new Promise<void>((resolveOption, rejectOption) => {
              db.run(
                'INSERT INTO poll_options (poll_id, option_text) VALUES (?, ?)',
                [pollId, option.trim()],
                (err) => {
                  if (err) rejectOption(err);
                  else resolveOption();
                }
              );
            });
          });

          // Wait for all options to be inserted
          Promise.all(insertPromises)
            .then(() => {
              // Get the created poll data
              db.get(
                `SELECT 
                  id,
                  question,
                  datetime(end_time) as end_time,
                  datetime(created_at) as created_at,
                  is_active
                FROM polls WHERE id = ?`,
                [pollId],
                (err, poll) => {
                  if (err) {
                    db.run('ROLLBACK');
                    reject(err);
                    return;
                  }

                  // Commit transaction and return poll data
                  db.run('COMMIT', (err) => {
                    if (err) {
                      db.run('ROLLBACK');
                      reject(err);
                    } else {
                      resolve({
                        ...poll as PollData,
                        options
                      });
                    }
                  });
                }
              );
            })
            .catch((err) => {
              db.run('ROLLBACK');
              reject(err);
            });
        }
      );
    });
  });
}

// Handle a vote on a poll
export async function handleVote(
  ctx: Context,
  pollId: number,
  optionIndex: number
): Promise<{ success: boolean; message: string }> {
  const db = getDb();

  // Check if poll exists and is active
  const poll = await new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM polls 
       WHERE id = ? AND is_active = 1 
       AND datetime('now') < datetime(end_time)`,
      [pollId],
      (err, result) => {
        if (err) reject(err);
        else resolve(result);
      }
    );
  });

  if (!poll) {
    return { success: false, message: 'This poll has ended or does not exist' };
  }

  // Get the selected option
  const option = await new Promise((resolve, reject) => {
    db.get(
      `SELECT id, option_text 
       FROM poll_options 
       WHERE poll_id = ? 
       ORDER BY id ASC 
       LIMIT 1 OFFSET ?`,
      [pollId, optionIndex],
      (err, result) => {
        if (err) reject(err);
        else resolve(result);
      }
    );
  });

  if (!option) {
    return { success: false, message: 'Invalid option selected' };
  }

  // Record or update the vote
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO votes (poll_id, option_id, user_id)
       VALUES (?, ?, ?)`,
      [pollId, (option as any).id, ctx.from?.id],
      (err) => {
        if (err) {
          reject(err);
        } else {
          resolve({
            success: true,
            message: 'Your vote has been recorded!'
          });
        }
      }
    );
  });
}

// Get poll results
export async function getPollResults(pollId: number): Promise<PollResults> {
  const db = getDb();

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Get poll information
      db.get(
        `SELECT 
          question,
          datetime(end_time) as end_time,
          is_active
        FROM polls 
        WHERE id = ?`,
        [pollId],
        (err, poll) => {
          if (err) {
            reject(err);
            return;
          }

          if (!poll) {
            reject(new Error('Poll not found'));
            return;
          }

          // Get options and vote counts
          db.all(
            `SELECT 
              po.id,
              po.option_text,
              COUNT(v.id) as vote_count
            FROM poll_options po
            LEFT JOIN votes v ON po.id = v.option_id
            WHERE po.poll_id = ?
            GROUP BY po.id, po.option_text
            ORDER BY po.id ASC`,
            [pollId],
            (err, options) => {
              if (err) {
                reject(err);
                return;
              }

              const totalVotes = options.reduce(
                (sum, opt) => sum + (opt as any).vote_count,
                0
              );

              resolve({
                question: (poll as any).question,
                options: options as PollOption[],
                total_votes: totalVotes as number,
                is_active: (poll as any).is_active === 1,
                end_time: (poll as any).end_time
              });
            }
          );
        }
      );
    });
  });
}

// Get user's current vote
export async function getUserVote(
  pollId: number,
  userId: string
): Promise<string | null> {
  const db = getDb();

  return new Promise((resolve, reject) => {
    db.get(
      `SELECT po.option_text
       FROM votes v
       JOIN poll_options po ON v.option_id = po.id
       WHERE v.poll_id = ? AND v.user_id = ?`,
      [pollId, userId],
      (err, result) => {
        if (err) reject(err);
        else resolve(result ? (result as any).option_text : null);
      }
    );
  });
}

// Format poll results for display
export function formatPollResults(results: PollResults): string {
  const { question, options, total_votes, is_active, end_time } = results;
  
  let output = `📊 ${question}\n\n`;
  
  options.forEach(opt => {
    const percentage = total_votes ? ((opt.vote_count / total_votes) * 100).toFixed(1) : '0.0';
    const bar = '█'.repeat(Math.floor(Number(percentage) / 5)) + 
                '░'.repeat(20 - Math.floor(Number(percentage) / 5));
    output += `${opt.option_text}\n${bar} ${percentage}% (${opt.vote_count} votes)\n\n`;
  });

  output += `Total votes: ${total_votes}\n`;
  
  if (!is_active) {
    output += '❌ This poll has ended';
  } else {
    const endDate = new Date(end_time);
    output += `⏰ Ends at: ${endDate.toLocaleString()}`;
  }

  return output;
}

// End a poll
export async function endPoll(pollId: number): Promise<boolean> {
  const db = getDb();

  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE polls SET is_active = 0 WHERE id = ?',
      [pollId],
      (err) => {
        if (err) reject(err);
        else resolve(true);
      }
    );
  });
}

// Check if a poll exists and is active
export async function isPollActive(pollId: number): Promise<boolean> {
  const db = getDb();

  return new Promise((resolve, reject) => {
    db.get(
      `SELECT 1 FROM polls 
       WHERE id = ? AND is_active = 1 
       AND datetime('now') < datetime(end_time)`,
      [pollId],
      (err, result) => {
        if (err) reject(err);
        else resolve(!!result);
      }
    );
  });
}

// Get all active polls for a chat
export async function getActivePollsForChat(chatId: string): Promise<PollData[]> {
  const db = getDb();

  return new Promise((resolve, reject) => {
    db.all(
      `SELECT 
        p.id,
        p.question,
        p.end_time,
        p.created_at,
        p.is_active,
        GROUP_CONCAT(po.option_text) as options
      FROM polls p
      JOIN poll_options po ON p.id = po.poll_id
      WHERE p.channel_id = ? 
      AND p.is_active = 1 
      AND datetime('now') < datetime(p.end_time)
      GROUP BY p.id`,
      [chatId],
      (err, polls) => {
        if (err) {
          reject(err);
        } else {
          resolve(polls.map(poll => ({
            ...(poll as any),
            options: (poll as any).options.split(',')
          })));
        }
      }
    );
  });
}