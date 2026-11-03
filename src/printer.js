const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { renderTicket } = require('./escpos');
const { nowIso } = require('./db');

function sendTcp(ip, port, buffer, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve();
    };
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => finish(new Error(`Printer timeout after ${timeoutMs}ms`)));
    socket.once('error', (error) => finish(error));
    socket.connect(Number(port), ip, () => {
      socket.write(buffer, () => socket.end());
    });
    socket.once('close', () => finish());
  });
}

function dryRun(job, buffer, logsDir) {
  fs.mkdirSync(logsDir, { recursive: true });
  const base = path.join(logsDir, `print-${job.job_number || job.id}`);
  fs.writeFileSync(`${base}.txt`, job.payload || '', 'utf8');
  fs.writeFileSync(`${base}.bin`, buffer);
  return `${base}.txt`;
}

async function processPrintQueue(db, config, logger = console) {
  const due = await db.all(
    `SELECT * FROM print_jobs
     WHERE status = 'QUEUED'
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY id ASC
     LIMIT 10`,
    [nowIso()],
  );

  for (const job of due) {
    const buffer = renderTicket(job.payload, {
      encoding: config.printer.encoding,
      cut: true,
      cashDrawer: job.document_type === 'RECEIPT',
    });

    try {
      let result;
      if (config.printer.dryRun || !config.printer.ip) {
        result = `dry-run: ${dryRun(job, buffer, path.join(config.root, 'logs'))}`;
      } else {
        await sendTcp(config.printer.ip, config.printer.port, buffer);
        result = 'printed';
      }
      await db.run(
        `UPDATE print_jobs SET status = 'PRINTED', printed_at = ?, updated_at = ?, last_error = NULL WHERE id = ?`,
        [nowIso(), nowIso(), job.id],
      );
      logger.log(`[print] ${job.job_number} ${job.document_type} -> ${result}`);
    } catch (error) {
      const attempts = Number(job.attempts || 0) + 1;
      const delay = Math.min(5 * 60 * 1000, 15_000 * 2 ** Math.min(attempts, 5));
      const status = attempts >= 8 ? 'FAILED' : 'QUEUED';
      await db.run(
        `UPDATE print_jobs
         SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
        [status, attempts, new Date(Date.now() + delay).toISOString(), error.message, nowIso(), job.id],
      );
      logger.error(`[print] ${job.job_number} failed: ${error.message}`);
    }
  }
}

async function testPrint(db, config) {
  const jobNumber = `TEST-${Date.now()}`;
  const text = [
    '================================',
    '        PRINTER TEST',
    '================================',
    `Restaurant : ${config.restaurantName}`,
    `Printer    : ${config.printer.name}`,
    `Address    : ${config.printer.ip}:${config.printer.port}`,
    `Time       : ${new Date().toLocaleString('en-GB')}`,
    '--------------------------------',
    'If you can read this, printing',
    'is configured correctly.',
    '',
    '',
    '',
  ].join('\n');

  await db.run(
    `INSERT INTO print_jobs
       (job_number, document_type, station, payload, status, created_at, updated_at)
     VALUES (?, 'TEST', 'Printer', ?, 'QUEUED', ?, ?)`,
    [jobNumber, text, nowIso(), nowIso()],
  );
  return jobNumber;
}

module.exports = { sendTcp, processPrintQueue, testPrint };
