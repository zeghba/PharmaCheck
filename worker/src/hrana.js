/* =====================================================================
   Turso / libSQL over HTTP (Hrana v2 "pipeline").

   A pipeline is one connection: the requests in a single POST run in
   order on the same stream, so BEGIN … COMMIT inside one pipeline is a
   real transaction. That is the only reason `tx()` below is safe.
   ===================================================================== */

export function toValue(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  if (typeof v === 'number') {
    if (!isFinite(v)) return { type: 'null' };
    return Number.isInteger(v)
      ? { type: 'integer', value: String(v) }
      : { type: 'float', value: v };
  }
  return { type: 'text', value: String(v) };
}

export function fromValue(v) {
  if (!v || v.type === 'null') return null;
  if (v.type === 'integer') return Number(v.value);
  if (v.type === 'float') return typeof v.value === 'number' ? v.value : Number(v.value);
  return v.value;
}

/* Turso hands out `libsql://host` and `wss://host`; the HTTP API is the
   same host over https. Accepting all three spellings means a URL pasted
   from any part of the dashboard works. */
export function httpUrl(url) {
  var u = String(url || '').trim().replace(/\/+$/, '');
  return u.replace(/^libsql:\/\//, 'https://').replace(/^wss:\/\//, 'https://');
}

function rowsOf(result) {
  var cols = (result.cols || []).map(function (c) { return c.name; });
  return (result.rows || []).map(function (row) {
    var out = {};
    row.forEach(function (cell, i) { out[cols[i]] = fromValue(cell); });
    return out;
  });
}

export class Db {
  constructor(url, token) {
    this.url = httpUrl(url);
    this.token = token;
  }

  /* Runs every statement on one connection and returns one result set per
     statement. `stmts` entries are either a SQL string or [sql, args]. */
  async pipeline(stmts) {
    var requests = stmts.map(function (s) {
      var sql = Array.isArray(s) ? s[0] : s;
      var args = Array.isArray(s) ? (s[1] || []) : [];
      return { type: 'execute', stmt: { sql: sql, args: args.map(toValue) } };
    });
    requests.push({ type: 'close' });

    var res = await fetch(this.url + '/v2/pipeline', {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + this.token,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ requests: requests })
    });

    if (!res.ok) {
      var text = await res.text();
      throw new DbError('Database rejected the request (' + res.status + '): ' + text.slice(0, 300), res.status);
    }

    var body = await res.json();
    var out = [];
    (body.results || []).forEach(function (r) {
      if (r.type === 'error') {
        throw new DbError(
          (r.error && r.error.message) || 'Unknown database error',
          400,
          r.error && r.error.code
        );
      }
      if (r.response && r.response.type === 'execute') {
        var result = r.response.result;
        out.push({
          rows: rowsOf(result),
          affected: result.affected_row_count || 0,
          lastRowid: result.last_insert_rowid || null
        });
      }
    });
    return out;
  }

  async execute(sql, args) {
    var out = await this.pipeline([[sql, args || []]]);
    return out[0];
  }

  async all(sql, args) { return (await this.execute(sql, args)).rows; }

  async one(sql, args) {
    var rows = await this.all(sql, args);
    return rows.length ? rows[0] : null;
  }

  /* Wraps the statements in a transaction on a single connection, so a
     half-applied batch is not a state the database can end up in. */
  async tx(stmts) {
    var out = await this.pipeline(['BEGIN'].concat(stmts, ['COMMIT']));
    return out.slice(1, -1);
  }
}

export class DbError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'DbError';
    this.status = status || 500;
    this.code = code || null;
  }
}
