'use strict';

const forbiddenStatementKeywords = new Set([
  'ATTACH',
  'BEGIN',
  'COMMIT',
  'DETACH',
  'END',
  'RELEASE',
  'ROLLBACK',
  'SAVEPOINT',
]);

function skipQuoted(sql, start, quote) {
  const closing = quote === '[' ? ']' : quote;
  for (let index = start + 1; index < sql.length; index += 1) {
    if (sql[index] !== closing) continue;
    if (quote !== '[' && sql[index + 1] === closing) {
      index += 1;
      continue;
    }
    return index + 1;
  }
  return sql.length;
}

function findForbiddenMigrationStatement(bytes) {
  const sql = bytes.toString('utf8');
  let statementStart = true;
  let statementWords = [];
  let inTrigger = false;
  let triggerBodyStarted = false;
  let triggerEndCandidate = false;
  let caseDepth = 0;

  for (let index = 0; index < sql.length;) {
    const character = sql[index];
    const next = sql[index + 1];

    if (character === '-' && next === '-') {
      const newline = sql.indexOf('\n', index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (character === '/' && next === '*') {
      const closing = sql.indexOf('*/', index + 2);
      index = closing === -1 ? sql.length : closing + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      index = skipQuoted(sql, index, character);
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end])) end += 1;
      const keyword = sql.slice(index, end).toUpperCase();

      if (statementStart) {
        if (forbiddenStatementKeywords.has(keyword)) return keyword;
        statementStart = false;
      }

      if (!inTrigger) {
        statementWords.push(keyword);
        if (statementWords.length > 3) statementWords = [];
        if (
          statementWords[0] === 'CREATE' &&
          (statementWords[1] === 'TRIGGER' ||
            ((statementWords[1] === 'TEMP' || statementWords[1] === 'TEMPORARY') && statementWords[2] === 'TRIGGER'))
        ) {
          inTrigger = true;
        }
      } else if (!triggerBodyStarted && keyword === 'BEGIN') {
        triggerBodyStarted = true;
      } else if (triggerBodyStarted && keyword === 'CASE') {
        caseDepth += 1;
      } else if (triggerBodyStarted && keyword === 'END') {
        if (caseDepth > 0) caseDepth -= 1;
        else triggerEndCandidate = true;
      }

      index = end;
      continue;
    }
    if (character === ';') {
      if (!inTrigger || triggerEndCandidate) {
        statementStart = true;
        statementWords = [];
        inTrigger = false;
        triggerBodyStarted = false;
        triggerEndCandidate = false;
        caseDepth = 0;
      }
    }
    index += 1;
  }

  return null;
}

module.exports = { findForbiddenMigrationStatement };
