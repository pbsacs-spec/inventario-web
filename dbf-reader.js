require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const Database = require('better-sqlite3');

const SQLITE_PATH = process.env.SQLITE_PATH || './inventario.db';

let db = null;

function getDb() {
  if (!db) db = new Database(SQLITE_PATH, { readonly: true });
  return db;
}

// ── Consultas ────────────────────────────────────────────────────────────────

function consultarExistencias(params = {}) {
  const db = getDb();

  let sql = `
    SELECT e.cve_prod, e.cse_prod, e.lugar, e.existencia, e.fech_umod,
           p.nom_prod, p.desc_prod, p.uni_med, p.pzas, p.capacidad
    FROM existencias e
    LEFT JOIN productos p ON e.cve_prod = p.cve_prod
    WHERE 1=1
  `;
  const args = [];

  if (params.cve_prod) {
    sql += ' AND UPPER(e.cve_prod) = ?';
    args.push(params.cve_prod.toUpperCase());
  }
  if (params.cse_prod) {
    sql += ' AND e.cse_prod = ?';
    args.push(params.cse_prod);
  }
  if (params.busqueda) {
    const b = '%' + params.busqueda.toUpperCase() + '%';
    sql += ' AND (UPPER(e.cve_prod) LIKE ? OR UPPER(p.desc_prod) LIKE ? OR UPPER(p.nom_prod) LIKE ?)';
    args.push(b, b, b);
  }
  if (params.lugar) {
    sql += ' AND UPPER(e.lugar) = ?';
    args.push(params.lugar.toUpperCase());
  }
  if (params.solo_positivos) {
    sql += ' AND e.existencia > 0';
  }

  sql += ' ORDER BY e.cve_prod, e.lugar';

  const rows = db.prepare(sql).all(...args);

  return rows.map(r => {
    const pzas      = parseInt(r.pzas)       || 0;
    const capacidad = parseFloat(r.capacidad) || 0;

    const base = {
      cve_prod:         r.cve_prod,
      cse_prod:         r.cse_prod,
      lugar:            r.lugar,
      existencia:       r.existencia,
      unidad_medida:    r.uni_med || 'METRO',
      descripcion:      r.desc_prod || r.nom_prod || '',
      fecha_ultimo_mov: r.fech_umod,
    };

    if (params.incluir_piezas || pzas > 0 || capacidad > 0 || params.metros_por_pieza) {
      let factorPiezas = null;
      let modo = null;

      if (pzas > 0) {
        factorPiezas = pzas;
        modo = 'pzas_x_unidad';
        base.piezas_a_surtir = Math.floor(r.existencia * factorPiezas);
      } else if (capacidad > 0) {
        factorPiezas = capacidad;
        modo = 'capacidad_x_unidad';
        base.piezas_a_surtir = Math.floor(r.existencia * factorPiezas);
      } else if (params.metros_por_pieza > 0) {
        factorPiezas = params.metros_por_pieza;
        modo = 'metros_por_pieza_manual';
        base.piezas_a_surtir = Math.floor(r.existencia / factorPiezas);
      } else {
        base.piezas_a_surtir = null;
      }

      if (factorPiezas !== null) {
        base.factor_conversion = factorPiezas;
        base.modo_calculo = modo;
      }
    }

    return base;
  });
}

function resumenPorCategoria(params = {}) {
  const db = getDb();

  let sql = `
    SELECT e.cse_prod,
           SUM(e.existencia)                                   AS total_existencia,
           SUM(CASE WHEN p.pzas > 0
                    THEN CAST(e.existencia * p.pzas AS INTEGER)
                    WHEN p.capacidad > 0
                    THEN CAST(e.existencia * p.capacidad AS INTEGER)
                    ELSE 0 END)                                AS total_piezas,
           COUNT(DISTINCT e.cve_prod)                         AS num_productos
    FROM existencias e
    LEFT JOIN productos p ON e.cve_prod = p.cve_prod
    WHERE 1=1
  `;
  const args = [];

  if (params.lugar) {
    sql += ' AND UPPER(e.lugar) = ?';
    args.push(params.lugar.toUpperCase());
  }
  if (params.solo_positivos) {
    sql += ' AND e.existencia > 0';
  }

  sql += ' GROUP BY e.cse_prod ORDER BY total_existencia DESC';

  return db.prepare(sql).all(...args);
}

function listarAlmacenes() {
  return getDb()
    .prepare("SELECT DISTINCT lugar FROM existencias WHERE lugar != '' ORDER BY lugar")
    .all()
    .map(r => r.lugar);
}

function listarCategorias() {
  return getDb()
    .prepare("SELECT DISTINCT cse_prod FROM existencias WHERE cse_prod != '' ORDER BY cse_prod")
    .all()
    .map(r => r.cse_prod);
}

function limpiarCache() {
  if (db) {
    db.close();
    db = null;
  }
}

function buscarClientes({ termino, cve_cte, cve_age } = {}) {
  let sql = `SELECT cve_cte, nom_cte, rfc_cte, tel1_cte, movil_cte,
                    cd_cte, edo_cte, lim_cre, dia_cre, contacto, email_cte
             FROM clientes WHERE 1=1`;
  const args = [];

  if (cve_cte) {
    sql += ' AND cve_cte = ?';
    args.push(Number(cve_cte));
  }
  if (cve_age) {
    sql += ' AND cve_age = ?';
    args.push(Number(cve_age));
  }
  if (termino) {
    sql += ` AND (nom_cte LIKE ? OR rfc_cte LIKE ? OR contacto LIKE ?
                 OR cd_cte LIKE ? OR tel1_cte LIKE ? OR movil_cte LIKE ?)`;
    const like = '%' + termino + '%';
    args.push(like, like, like, like, like, like);
  }
  sql += ' ORDER BY nom_cte LIMIT 200';
  return getDb().prepare(sql).all(...args);
}

function listarAgentesConConteo() {
  return getDb().prepare(`
    SELECT a.cve_age, a.nom_age, COUNT(c.cve_cte) AS total
    FROM agentes a
    LEFT JOIN clientes c ON c.cve_age = a.cve_age
    GROUP BY a.cve_age, a.nom_age
    HAVING total > 0
    ORDER BY a.nom_age
  `).all();
}

function buscarAgentes({ termino, cve_age } = {}) {
  let sql = `SELECT cve_age, nom_age, area_age, tel1_age, tel2_age, email_age,
                    rfc_age, cd_age, edo_age, com_age, tipo_age, cve_empl
             FROM agentes WHERE 1=1`;
  const args = [];

  if (cve_age) {
    sql += ' AND cve_age = ?';
    args.push(Number(cve_age));
  }
  if (termino) {
    sql += ` AND (nom_age LIKE ? OR area_age LIKE ? OR rfc_age LIKE ?
                 OR cd_age LIKE ? OR tel1_age LIKE ? OR email_age LIKE ?)`;
    const like = '%' + termino + '%';
    args.push(like, like, like, like, like, like);
  }
  sql += ' ORDER BY nom_age';
  return getDb().prepare(sql).all(...args);
}

module.exports = {
  consultarExistencias,
  resumenPorCategoria,
  listarAlmacenes,
  listarCategorias,
  limpiarCache,
  buscarClientes,
  buscarAgentes,
  listarAgentesConConteo,
};
