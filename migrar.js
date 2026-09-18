/**
 * migrar.js — Importa datos de los archivos DBF a SQLite
 *
 * Uso:
 *   node migrar.js
 *
 * Lee producto.dbf y existe.dbf desde DB_PATH (.env)
 * y crea/actualiza inventario.db en SQLITE_PATH (.env)
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH    = process.env.DB_PATH    || 'D:/VSAI/Empresas/EMP4';
const SQLITE_PATH = process.env.SQLITE_PATH || './inventario.db';

// ── Lector DBF ───────────────────────────────────────────────────────────────

function readDbfFull(filename) {
  const buf = fs.readFileSync(path.join(DB_PATH, filename));

  const numRecords  = buf.readUInt32LE(4);
  const headerBytes = buf.readUInt16LE(8);
  const recordBytes = buf.readUInt16LE(10);

  const fields = [];
  let offset = 32;
  while (offset + 32 <= headerBytes) {
    if (buf[offset] === 0x0D) break;
    const name = buf.slice(offset, offset + 11).toString('ascii').replace(/\0/g, '').trim();
    const type = String.fromCharCode(buf[offset + 11]);
    const len  = buf[offset + 16];
    const dec  = buf[offset + 17];
    fields.push({ name, type, len, dec });
    offset += 32;
  }

  const rows = [];
  for (let r = 0; r < numRecords; r++) {
    const recOff = headerBytes + r * recordBytes;
    if (recOff + recordBytes > buf.length) break;
    if (buf[recOff] === 0x2A) continue;

    const row = {};
    let fOff = recOff + 1;
    for (const f of fields) {
      const raw = buf.slice(fOff, fOff + f.len).toString('latin1').trim();
      if (f.type === 'N') {
        row[f.name] = raw === '' ? 0 : parseFloat(raw) || 0;
      } else if (f.type === 'L') {
        row[f.name] = raw.toUpperCase() === 'T' || raw === '1' ? 1 : 0;
      } else if (f.type === 'M') {
        // memo — skip
      } else {
        row[f.name] = raw;
      }
      fOff += f.len;
    }
    rows.push(row);
  }
  return { fields, rows };
}

function readDbf(filename) {
  return readDbfFull(filename).rows;
}

// ── Migración ────────────────────────────────────────────────────────────────

function migrar() {
  const inicio = Date.now();
  console.log(`📂 Leyendo DBFs desde: ${DB_PATH}`);

  const productos   = readDbf('producto.dbf');
  const existencias = readDbf('existe.dbf');
  console.log(`  producto.dbf  → ${productos.length} registros`);
  console.log(`  existe.dbf    → ${existencias.length} registros`);

  const db = new Database(SQLITE_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS productos (
      cve_prod  TEXT PRIMARY KEY,
      nom_prod  TEXT,
      desc_prod TEXT,
      uni_med   TEXT,
      pzas      INTEGER DEFAULT 0,
      capacidad REAL    DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS existencias (
      cve_prod   TEXT,
      cse_prod   TEXT,
      lugar      TEXT,
      existencia REAL,
      fech_umod  TEXT,
      PRIMARY KEY (cve_prod, lugar)
    );

    CREATE INDEX IF NOT EXISTS idx_ext_cse   ON existencias(cse_prod);
    CREATE INDEX IF NOT EXISTS idx_ext_lugar ON existencias(lugar);
    CREATE INDEX IF NOT EXISTS idx_ext_cve   ON existencias(cve_prod);
  `);

  // Vaciar tablas antes de reimportar
  db.exec('DELETE FROM existencias; DELETE FROM productos;');

  const insertProducto = db.prepare(`
    INSERT OR REPLACE INTO productos (cve_prod, nom_prod, desc_prod, uni_med, pzas, capacidad)
    VALUES (@cve_prod, @nom_prod, @desc_prod, @uni_med, @pzas, @capacidad)
  `);

  const insertExistencia = db.prepare(`
    INSERT OR REPLACE INTO existencias (cve_prod, cse_prod, lugar, existencia, fech_umod)
    VALUES (@cve_prod, @cse_prod, @lugar, @existencia, @fech_umod)
  `);

  // Agregar existencias por (CVE_PROD, LUGAR) antes de insertar
  const aggMap = {};
  for (const e of existencias) {
    const key = `${e.CVE_PROD}|${e.LUGAR}`;
    if (!aggMap[key]) {
      aggMap[key] = { ...e };
    } else {
      aggMap[key].EXISTENCIA += e.EXISTENCIA || 0;
      if ((e.FECH_UMOD || '') > (aggMap[key].FECH_UMOD || '')) {
        aggMap[key].FECH_UMOD = e.FECH_UMOD;
      }
    }
  }
  const existenciasAgg = Object.values(aggMap);

  const insertarTodo = db.transaction(() => {
    for (const p of productos) {
      insertProducto.run({
        cve_prod:  p.CVE_PROD  || '',
        nom_prod:  p.NOM_PROD  || '',
        desc_prod: p.DESC_PROD || '',
        uni_med:   p.UNI_MED   || '',
        pzas:      parseInt(p.PZAS)       || 0,
        capacidad: parseFloat(p.CAPACIDAD) || 0,
      });
    }
    for (const e of existenciasAgg) {
      insertExistencia.run({
        cve_prod:   e.CVE_PROD   || '',
        cse_prod:   e.CSE_PROD   || '',
        lugar:      e.LUGAR      || '',
        existencia: e.EXISTENCIA || 0,
        fech_umod:  e.FECH_UMOD  || '',
      });
    }
  });

  insertarTodo();

  migrarClientes(db);
  migrarAgentes(db);

  db.close();

  const ms = Date.now() - inicio;
  console.log(`✅ Migración completada en ${ms} ms → ${SQLITE_PATH}`);
  return { productos: productos.length, existencias: existencias.length, ms };
}

// ── Migración de clientes ─────────────────────────────────────────────────────

function migrarClientes(dbArg) {
  const inicio = Date.now();
  const db = dbArg || new Database(SQLITE_PATH);

  console.log('  clientes.DBF  → leyendo…');
  const { fields, rows } = readDbfFull('clientes.DBF');

  // Omitir campos memo (M) — su contenido real está en el .FPT
  const usable = fields.filter(f => f.type !== 'M');

  // Crear tabla con esquema dinámico
  const colDefs = usable.map(f => {
    const sql = f.type === 'N' ? (f.dec > 0 ? 'REAL' : 'INTEGER')
              : f.type === 'L' ? 'INTEGER'
              : 'TEXT';
    return `  ${f.name.toLowerCase()} ${sql}`;
  }).join(',\n');

  db.exec('DROP TABLE IF EXISTS clientes;');
  db.exec(`CREATE TABLE clientes (\n${colDefs}\n);`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_cte_cve ON clientes(cve_cte);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cte_nom ON clientes(nom_cte);');

  const colNames    = usable.map(f => f.name.toLowerCase()).join(', ');
  const params      = usable.map(f => '@' + f.name.toLowerCase()).join(', ');
  const insertStmt  = db.prepare(`INSERT INTO clientes (${colNames}) VALUES (${params})`);

  const insertarTodo = db.transaction(() => {
    for (const row of rows) {
      const mapped = {};
      for (const f of usable) mapped[f.name.toLowerCase()] = row[f.name] ?? null;
      insertStmt.run(mapped);
    }
  });
  insertarTodo();

  const ms = Date.now() - inicio;
  console.log(`  clientes.DBF  → ${rows.length} registros (${ms} ms)`);

  if (!dbArg) db.close();
  return rows.length;
}

// ── Migración de agentes ──────────────────────────────────────────────────────

function migrarAgentes(dbArg) {
  const inicio = Date.now();
  const db = dbArg || new Database(SQLITE_PATH);

  console.log('  agentes.DBF   → leyendo…');
  const { fields, rows } = readDbfFull('agentes.DBF');

  // D (fecha) y M (memo) → TEXT; N con dec → REAL; N sin dec → INTEGER; L → INTEGER
  const usable = fields.filter(f => f.type !== 'M');

  const colDefs = usable.map(f => {
    const sql = f.type === 'N' ? (f.dec > 0 ? 'REAL' : 'INTEGER')
              : f.type === 'L' ? 'INTEGER'
              : 'TEXT';
    return `  ${f.name.toLowerCase()} ${sql}`;
  }).join(',\n');

  db.exec('DROP TABLE IF EXISTS agentes;');
  db.exec(`CREATE TABLE agentes (\n${colDefs}\n);`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_age_cve ON agentes(cve_age);');

  const colNames   = usable.map(f => f.name.toLowerCase()).join(', ');
  const params     = usable.map(f => '@' + f.name.toLowerCase()).join(', ');
  const insertStmt = db.prepare(`INSERT INTO agentes (${colNames}) VALUES (${params})`);

  const insertarTodo = db.transaction(() => {
    for (const row of rows) {
      const mapped = {};
      for (const f of usable) mapped[f.name.toLowerCase()] = row[f.name] ?? null;
      insertStmt.run(mapped);
    }
  });
  insertarTodo();

  const ms = Date.now() - inicio;
  console.log(`  agentes.DBF   → ${rows.length} registros (${ms} ms)`);

  if (!dbArg) db.close();
  return rows.length;
}

module.exports = { migrar, migrarClientes, migrarAgentes };

if (require.main === module) {
  migrar();
}
