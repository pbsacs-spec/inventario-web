/**
 * exportar-mysql.js
 * Convierte inventario.db (SQLite) a inventario.sql (MySQL)
 * Uso: node exportar-mysql.js
 * Genera: inventario.sql listo para importar en cPanel / phpMyAdmin
 */

const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, 'inventario.db');
const OUT_FILE    = path.join(__dirname, 'inventario.sql');

const db = new Database(SQLITE_PATH, { readonly: true });

const lines = [];

lines.push('-- Inventario Web — dump MySQL');
lines.push('-- Generado: ' + new Date().toISOString());
lines.push('SET NAMES utf8mb4;');
lines.push('SET foreign_key_checks = 0;');
lines.push('');

// ── Tablas a exportar ────────────────────────────────────────────────────────

function esc(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number')         return String(v);
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

function exportTable(name, ddl) {
  lines.push(`-- Tabla: ${name}`);
  lines.push(`DROP TABLE IF EXISTS \`${name}\`;`);
  lines.push(ddl + ';');
  lines.push('');

  const rows = db.prepare(`SELECT * FROM ${name}`).all();
  if (rows.length === 0) return;

  const cols = Object.keys(rows[0]);
  const colList = cols.map(c => `\`${c}\``).join(', ');

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk.map(row => '(' + cols.map(c => esc(row[c])).join(', ') + ')');
    lines.push(`INSERT INTO \`${name}\` (${colList}) VALUES`);
    lines.push(values.join(',\n') + ';');
  }
  lines.push('');
  console.log(`  ${name}: ${rows.length} filas`);
}

// productos
exportTable('productos', `CREATE TABLE \`productos\` (
  \`cve_prod\`  VARCHAR(50)  NOT NULL,
  \`nom_prod\`  TEXT,
  \`desc_prod\` TEXT,
  \`uni_med\`   VARCHAR(20),
  \`pzas\`      INT          DEFAULT 0,
  \`capacidad\` DOUBLE       DEFAULT 0,
  PRIMARY KEY (\`cve_prod\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

// existencias
exportTable('existencias', `CREATE TABLE \`existencias\` (
  \`cve_prod\`   VARCHAR(50)  NOT NULL,
  \`cse_prod\`   VARCHAR(50),
  \`lugar\`      VARCHAR(50)  NOT NULL,
  \`existencia\` DOUBLE,
  \`fech_umod\`  VARCHAR(20),
  PRIMARY KEY (\`cve_prod\`, \`lugar\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

// clientes (solo campos usados en búsqueda)
exportTable('clientes', `CREATE TABLE \`clientes\` (
  \`cve_cte\`    INT,
  \`nom_cte\`    TEXT,
  \`rfc_cte\`    VARCHAR(30),
  \`tel1_cte\`   VARCHAR(30),
  \`movil_cte\`  VARCHAR(30),
  \`lim_cre\`    DOUBLE,
  \`dia_cre\`    INT,
  \`cve_age\`    INT,
  \`contacto\`   TEXT,
  \`email_cte\`  TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

lines.push('SET foreign_key_checks = 1;');

fs.writeFileSync(OUT_FILE, lines.join('\n'), 'utf8');
console.log('\nArchivo generado:', OUT_FILE);
console.log('Tamaño:', (fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(2), 'MB');
