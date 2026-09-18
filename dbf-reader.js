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
    creado_en     DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await query(`CREATE TABLE IF NOT EXISTS consultas_log (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    usuario_id INT,
    usuario    VARCHAR(50),
    consulta   TEXT,
    tipo       VARCHAR(20),
    ip         VARCHAR(45),
    fecha      DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
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

async function crearUsuario(usuario, password_hash, nombre) {
  await query(
    'INSERT INTO usuarios (usuario, password_hash, nombre) VALUES (?, ?, ?)',
    [usuario, password_hash, nombre || usuario],
  );
}

async function registrarConsulta(usuario_id, usuario, consulta, tipo, ip) {
  await query(
    'INSERT INTO consultas_log (usuario_id, usuario, consulta, tipo, ip) VALUES (?, ?, ?, ?, ?)',
    [usuario_id, usuario, consulta, tipo, ip || ''],
  );
}

async function listarUsuarios() {
  return query('SELECT id, usuario, nombre, activo, creado_en FROM usuarios ORDER BY creado_en DESC');
}

async function toggleUsuario(id) {
  await query('UPDATE usuarios SET activo = NOT activo WHERE id = ?', [id]);
}

module.exports = {
  consultarExistencias, resumenPorCategoria, listarCategorias, buscarClientes, limpiarCache,
  crearTablas, buscarUsuario, contarUsuarios, crearUsuario, registrarConsulta,
  listarUsuarios, toggleUsuario,
};
