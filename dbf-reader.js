require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mysql = require('mysql2/promise');

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host:     process.env.DB_HOST || 'localhost',
      port:     parseInt(process.env.DB_PORT || '3306'),
      user:     process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || process.env.DB_PASS || '',
      database: process.env.DB_NAME || 'inventario',
      charset:  'utf8mb4',
      waitForConnections: true,
      connectionLimit: 5,
    });
  }
  return pool;
}

async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

// ── Existencias ──────────────────────────────────────────────────────────────

async function consultarExistencias(params = {}) {
  const { cve_prod, cse_prod, busqueda, lugar, solo_positivos } = params;

  let sql = `
    SELECT e.cve_prod, e.cse_prod, e.lugar, e.existencia, e.fech_umod,
           p.nom_prod, p.desc_prod, p.uni_med, p.pzas, p.capacidad,
           COALESCE(p.desc_prod, p.nom_prod) AS descripcion
    FROM existencias e
    LEFT JOIN productos p ON UPPER(e.cve_prod) = UPPER(p.cve_prod)
    WHERE 1=1`;
  const args = [];

  if (cve_prod)      { sql += ' AND UPPER(e.cve_prod) = ?';   args.push(cve_prod.toUpperCase()); }
  if (cse_prod)      { sql += ' AND e.cse_prod = ?';           args.push(cse_prod); }
  if (busqueda) {
    sql += ' AND (UPPER(e.cve_prod) LIKE ? OR UPPER(p.desc_prod) LIKE ? OR UPPER(p.nom_prod) LIKE ?)';
    const like = '%' + busqueda.toUpperCase() + '%';
    args.push(like, like, like);
  }
  if (lugar)         { sql += ' AND UPPER(e.lugar) = ?';       args.push(lugar.toUpperCase()); }
  if (solo_positivos){ sql += ' AND e.existencia > 0'; }

  sql += ' ORDER BY e.cve_prod, e.lugar';
  return query(sql, args);
}

async function resumenPorCategoria(params = {}) {
  const { lugar, solo_positivos } = params;

  let sql = `
    SELECT e.cse_prod,
           SUM(e.existencia)        AS total_existencia,
           COUNT(DISTINCT e.cve_prod) AS num_productos,
           SUM(p.pzas * e.existencia) AS total_piezas
    FROM existencias e
    LEFT JOIN productos p ON UPPER(e.cve_prod) = UPPER(p.cve_prod)
    WHERE 1=1`;
  const args = [];

  if (lugar)         { sql += ' AND UPPER(e.lugar) = ?'; args.push(lugar.toUpperCase()); }
  if (solo_positivos){ sql += ' AND e.existencia > 0'; }

  sql += ' GROUP BY e.cse_prod ORDER BY total_existencia DESC';
  return query(sql, args);
}

async function listarCategorias(params = {}) {
  const rows = await resumenPorCategoria(params);
  return rows.map(r => r.cse_prod).filter(Boolean);
}

// ── Clientes ─────────────────────────────────────────────────────────────────

async function buscarClientes(params = {}) {
  const { termino, cve_cte, cve_age } = params;

  let sql = `SELECT cve_cte, nom_cte, rfc_cte, tel1_cte, movil_cte,
                    lim_cre, dia_cre, cve_age, contacto, email_cte
             FROM clientes WHERE 1=1`;
  const args = [];

  if (cve_cte) { sql += ' AND cve_cte = ?'; args.push(cve_cte); }
  if (cve_age) { sql += ' AND cve_age = ?'; args.push(cve_age); }
  if (termino) {
    sql += ' AND (nom_cte LIKE ? OR rfc_cte LIKE ? OR contacto LIKE ? OR tel1_cte LIKE ? OR movil_cte LIKE ?)';
    const like = '%' + termino + '%';
    args.push(like, like, like, like, like);
  }

  sql += ' ORDER BY nom_cte LIMIT 200';
  return query(sql, args);
}

function limpiarCache() { /* no-op en MySQL */ }

// ── Auth / usuarios ───────────────────────────────────────────────────────────

async function crearTablas() {
  await query(`CREATE TABLE IF NOT EXISTS usuarios (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    usuario       VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    nombre        VARCHAR(100),
    activo        TINYINT(1) DEFAULT 1,
    rol           VARCHAR(20) DEFAULT 'admin',
    creado_en     DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // Migración para DBs existentes sin columna rol
  try { await query("ALTER TABLE usuarios ADD COLUMN rol VARCHAR(20) DEFAULT 'admin'"); } catch (_) {}
  await query(`CREATE TABLE IF NOT EXISTS consultas_log (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    usuario_id INT,
    usuario    VARCHAR(50),
    consulta   TEXT,
    tipo       VARCHAR(20),
    ip         VARCHAR(45),
    fecha      DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await query(`CREATE TABLE IF NOT EXISTS conceptos_movimiento (
    id        INT AUTO_INCREMENT PRIMARY KEY,
    nombre    VARCHAR(100) NOT NULL,
    tipo      ENUM('entrada','salida') NOT NULL,
    activo    TINYINT(1) DEFAULT 1,
    creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await query(`CREATE TABLE IF NOT EXISTS movimientos (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    tipo        ENUM('entrada','salida') NOT NULL,
    concepto_id INT,
    concepto    VARCHAR(100),
    cve_prod    VARCHAR(50) NOT NULL,
    lugar       VARCHAR(50) NOT NULL,
    cantidad    DECIMAL(12,4) NOT NULL,
    notas       TEXT,
    usuario_id  INT,
    usuario     VARCHAR(50),
    fecha       DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  const semCheck = await query('SELECT COUNT(*) AS n FROM conceptos_movimiento');
  if (semCheck[0].n === 0) {
    const semilla = [
      ['Compra',                'entrada'], ['Devolución de cliente', 'entrada'],
      ['Ajuste de entrada',     'entrada'], ['Traspaso entrada',      'entrada'],
      ['Venta',                 'salida'],  ['Devolución a proveedor','salida'],
      ['Merma',                 'salida'],  ['Ajuste de salida',      'salida'],
      ['Traspaso salida',       'salida'],
    ];
    for (const [nombre, tipo] of semilla)
      await query('INSERT INTO conceptos_movimiento (nombre, tipo) VALUES (?, ?)', [nombre, tipo]);
  }
}

async function buscarUsuario(usuario) {
  const rows = await query(
    'SELECT * FROM usuarios WHERE usuario = ? AND activo = 1 LIMIT 1',
    [usuario],
  );
  return rows[0] || null;
}

async function contarUsuarios() {
  const rows = await query('SELECT COUNT(*) AS n FROM usuarios');
  return rows[0].n;
}

async function crearUsuario(usuario, password_hash, nombre, rol = 'admin') {
  await query(
    'INSERT INTO usuarios (usuario, password_hash, nombre, rol) VALUES (?, ?, ?, ?)',
    [usuario, password_hash, nombre || usuario, rol],
  );
}

async function registrarConsulta(usuario_id, usuario, consulta, tipo, ip) {
  await query(
    'INSERT INTO consultas_log (usuario_id, usuario, consulta, tipo, ip) VALUES (?, ?, ?, ?, ?)',
    [usuario_id, usuario, consulta, tipo, ip || ''],
  );
}

async function listarUsuarios() {
  return query('SELECT id, usuario, nombre, activo, rol, creado_en FROM usuarios ORDER BY creado_en DESC');
}

async function toggleUsuario(id) {
  await query('UPDATE usuarios SET activo = NOT activo WHERE id = ?', [id]);
}

async function importarSQL(sql) {
  const conn = await mysql.createConnection({
    host:               process.env.DB_HOST     || 'localhost',
    port:               parseInt(process.env.DB_PORT || '3306'),
    user:               process.env.DB_USER     || 'root',
    password:           process.env.DB_PASSWORD || process.env.DB_PASS || '',
    database:           process.env.DB_NAME     || 'inventario',
    charset:            'utf8mb4',
    multipleStatements: true,
  });
  try {
    await conn.query(sql);
  } finally {
    await conn.end();
  }
}

async function actualizarUsuario(id, campos) {
  const sets = [];
  const vals = [];
  if (campos.nombre        !== undefined) { sets.push('nombre = ?');        vals.push(campos.nombre); }
  if (campos.usuario       !== undefined) { sets.push('usuario = ?');       vals.push(campos.usuario); }
  if (campos.password_hash !== undefined) { sets.push('password_hash = ?'); vals.push(campos.password_hash); }
  if (campos.rol           !== undefined) { sets.push('rol = ?');           vals.push(campos.rol); }
  if (!sets.length) return;
  vals.push(id);
  await query(`UPDATE usuarios SET ${sets.join(', ')} WHERE id = ?`, vals);
}

// ── Reportes / consultas_log ──────────────────────────────────────────────────

async function listarConsultas({ usuario, tipo, fecha_desde, fecha_hasta } = {}) {
  let sql = `SELECT id, usuario, consulta, tipo, ip, fecha FROM consultas_log WHERE 1=1`;
  const args = [];
  if (usuario)     { sql += ' AND usuario LIKE ?';   args.push('%' + usuario + '%'); }
  if (tipo)        { sql += ' AND tipo = ?';         args.push(tipo); }
  if (fecha_desde) { sql += ' AND DATE(fecha) >= ?'; args.push(fecha_desde); }
  if (fecha_hasta) { sql += ' AND DATE(fecha) <= ?'; args.push(fecha_hasta); }
  sql += ' ORDER BY fecha DESC LIMIT 500';
  return query(sql, args);
}

async function estadisticasConsultas() {
  const [r1, r2, r3, top] = await Promise.all([
    query(`SELECT COUNT(*) AS n FROM consultas_log WHERE DATE(fecha) = CURDATE()`),
    query(`SELECT COUNT(*) AS n FROM consultas_log WHERE fecha >= DATE_SUB(NOW(), INTERVAL 7 DAY)`),
    query(`SELECT COUNT(*) AS n FROM consultas_log WHERE fecha >= DATE_SUB(NOW(), INTERVAL 30 DAY)`),
    query(`SELECT usuario, COUNT(*) AS total FROM consultas_log
           WHERE fecha >= DATE_SUB(NOW(), INTERVAL 30 DAY)
           GROUP BY usuario ORDER BY total DESC LIMIT 6`),
  ]);
  return { hoy: r1[0].n, semana: r2[0].n, mes: r3[0].n, topUsuarios: top };
}

// ── Conceptos de movimiento ───────────────────────────────────────────────────

async function listarConceptos(soloActivos = true) {
  const where = soloActivos ? 'WHERE activo = 1' : '';
  return query(`SELECT id, nombre, tipo, activo FROM conceptos_movimiento ${where} ORDER BY tipo, nombre`);
}

async function crearConcepto(nombre, tipo) {
  await query('INSERT INTO conceptos_movimiento (nombre, tipo) VALUES (?, ?)', [nombre, tipo]);
}

async function toggleConcepto(id) {
  await query('UPDATE conceptos_movimiento SET activo = NOT activo WHERE id = ?', [id]);
}

// ── Movimientos de inventario ─────────────────────────────────────────────────

async function buscarProductosParaMovimiento(termino) {
  if (!termino || termino.length < 2) return [];
  const like = '%' + termino.toUpperCase() + '%';
  return query(
    `SELECT e.cve_prod, e.cse_prod, e.lugar, e.existencia,
            COALESCE(p.desc_prod, p.nom_prod) AS descripcion, p.uni_med
     FROM existencias e
     LEFT JOIN productos p ON UPPER(e.cve_prod) = UPPER(p.cve_prod)
     WHERE UPPER(e.cve_prod) LIKE ? OR UPPER(p.desc_prod) LIKE ? OR UPPER(p.nom_prod) LIKE ?
     ORDER BY e.cve_prod, e.lugar LIMIT 30`,
    [like, like, like]
  );
}

async function registrarMovimiento({ tipo, concepto_id, concepto, cve_prod, lugar, cantidad, notas, usuario_id, usuario }) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `INSERT INTO movimientos (tipo, concepto_id, concepto, cve_prod, lugar, cantidad, notas, usuario_id, usuario)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tipo, concepto_id || null, concepto || '', cve_prod.toUpperCase(), lugar.toUpperCase(),
       cantidad, notas || '', usuario_id, usuario]
    );
    const delta = tipo === 'entrada' ? cantidad : -cantidad;
    const [result] = await conn.execute(
      `UPDATE existencias SET existencia = existencia + ?, fech_umod = NOW()
       WHERE UPPER(cve_prod) = UPPER(?) AND UPPER(lugar) = UPPER(?)`,
      [delta, cve_prod, lugar]
    );
    if (result.affectedRows === 0) {
      if (tipo === 'entrada') {
        const [prod] = await conn.execute(
          'SELECT cse_prod FROM productos WHERE UPPER(cve_prod) = UPPER(?) LIMIT 1', [cve_prod]
        );
        const cse = prod[0] ? prod[0].cse_prod || '' : '';
        await conn.execute(
          `INSERT INTO existencias (cve_prod, cse_prod, lugar, existencia, fech_umod) VALUES (?, ?, ?, ?, NOW())`,
          [cve_prod.toUpperCase(), cse, lugar.toUpperCase(), cantidad]
        );
      } else {
        throw new Error(`No existe existencia de "${cve_prod}" en "${lugar}"`);
      }
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function listarMovimientos({ tipo, cve_prod, fecha_desde, fecha_hasta } = {}) {
  let sql = `
    SELECT m.id, m.tipo, m.concepto, m.cve_prod, m.lugar, m.cantidad, m.notas,
           m.usuario, m.fecha,
           COALESCE(p.desc_prod, p.nom_prod) AS descripcion
    FROM movimientos m
    LEFT JOIN productos p ON UPPER(m.cve_prod) = UPPER(p.cve_prod)
    WHERE 1=1`;
  const args = [];
  if (tipo)        { sql += ' AND m.tipo = ?';               args.push(tipo); }
  if (cve_prod)    { sql += ' AND UPPER(m.cve_prod) LIKE ?'; args.push('%' + cve_prod.toUpperCase() + '%'); }
  if (fecha_desde) { sql += ' AND DATE(m.fecha) >= ?';       args.push(fecha_desde); }
  if (fecha_hasta) { sql += ' AND DATE(m.fecha) <= ?';       args.push(fecha_hasta); }
  sql += ' ORDER BY m.fecha DESC LIMIT 300';
  return query(sql, args);
}

module.exports = {
  consultarExistencias, resumenPorCategoria, listarCategorias, buscarClientes, limpiarCache,
  crearTablas, buscarUsuario, contarUsuarios, crearUsuario, registrarConsulta,
  listarUsuarios, toggleUsuario, actualizarUsuario, importarSQL,
  listarConceptos, crearConcepto, toggleConcepto,
  buscarProductosParaMovimiento, registrarMovimiento, listarMovimientos,
  listarConsultas, estadisticasConsultas,
};
