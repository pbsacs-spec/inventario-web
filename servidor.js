require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express  = require('express');
const path     = require('path');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const { procesarMensaje }  = require('./consulta-keywords');
const { generarPdfBuffer } = require('./pdf-gen');
const {
  crearTablas,
  buscarUsuario,
  contarUsuarios,
  crearUsuario,
  registrarConsulta,
  listarUsuarios,
  toggleUsuario,
} = require('./dbf-reader');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'inventario-secret-cambiar',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));

crearTablas().catch(err => console.error('Error al crear tablas auth:', err));

// ── Autenticación ─────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/auth/login', async (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) return res.redirect('/login?err=1');
  try {
    const user = await buscarUsuario(usuario);
    if (!user) return res.redirect('/login?err=1');
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.redirect('/login?err=1');
    req.session.userId  = user.id;
    req.session.usuario = user.usuario;
    req.session.nombre  = user.nombre || user.usuario;
    res.redirect('/');
  } catch (_) {
    res.redirect('/login?err=1');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Setup (solo si no hay usuarios) ──────────────────────────────────────────

app.get('/setup', async (req, res) => {
  try {
    const n = await contarUsuarios();
    if (n > 0) return res.redirect('/login');
  } catch (_) {}
  res.send(setupHtml(req.query.err));
});

app.post('/setup', async (req, res) => {
  try {
    const n = await contarUsuarios();
    if (n > 0) return res.redirect('/login');
    const { usuario, password, nombre } = req.body;
    if (!usuario || !password) return res.redirect('/setup?err=1');
    const hash = await bcrypt.hash(password, 10);
    await crearUsuario(usuario, hash, nombre || usuario);
    res.redirect('/login?ok=1');
  } catch (_) {
    res.redirect('/setup?err=1');
  }
});

// ── Página principal (protegida) ──────────────────────────────────────────────

app.get('/', (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── API: sesión ───────────────────────────────────────────────────────────────

app.get('/api/me', (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ ok: false });
  res.json({ ok: true, usuario: req.session.usuario, nombre: req.session.nombre });
});

// ── Middleware de auth ────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ tipo: 'error', mensaje: 'Sesión expirada. Recarga la página.' });
}

function limpiarQuery(q) {
  return q
    .replace(/\b(pdf|txt|bajar|descargar|exportar|archivo)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── POST /api/consulta ────────────────────────────────────────────────────────

app.post('/api/consulta', requireAuth, async (req, res) => {
  const q = (req.body.q || '').trim();
  if (!q) return res.json({ tipo: 'error', mensaje: 'Consulta vacía' });
  const qLimpio = limpiarQuery(q);

  try {
    const resultado = await procesarMensaje(qLimpio + ' pdf');
    registrarConsulta(req.session.userId, req.session.usuario, qLimpio, 'consulta', req.ip).catch(() => {});

    if (resultado && typeof resultado === 'object') {
      if (resultado.tipo === 'pdf' && resultado.rawData && Array.isArray(resultado.rawData.columnas)) {
        return res.json({
          tipo:       'tabla',
          columnas:   resultado.rawData.columnas,
          alineacion: resultado.rawData.alineacion,
          filas:      resultado.rawData.filas,
          consulta:   qLimpio,
        });
      }
      return res.json({ tipo: 'texto', contenido: resultado.contenido || String(resultado), consulta: qLimpio });
    }

    if (typeof resultado === 'string') {
      const limpio = resultado
        .replace(/```\n?/g, '')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/_([^_]+)_/g, '$1');
      return res.json({ tipo: 'texto', contenido: limpio, consulta: qLimpio });
    }

    return res.json({ tipo: 'texto', contenido: String(resultado), consulta: qLimpio });
  } catch (err) {
    return res.json({ tipo: 'error', mensaje: err.message });
  }
});

// ── GET /api/pdf ──────────────────────────────────────────────────────────────

app.get('/api/pdf', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).send('Consulta vacía');
  const qLimpio = limpiarQuery(q);

  try {
    const resultado = await procesarMensaje(qLimpio + ' pdf');
    if (!resultado || typeof resultado !== 'object' || resultado.tipo !== 'pdf')
      return res.status(400).send('La consulta no generó datos exportables');

    registrarConsulta(req.session.userId, req.session.usuario, qLimpio, 'pdf', req.ip).catch(() => {});
    const buf = await generarPdfBuffer(resultado.rawData || resultado.contenido, 'WEB', '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="resultados.pdf"');
    res.send(buf);
  } catch (err) {
    res.status(500).send('Error al generar PDF: ' + err.message);
  }
});

// ── GET /api/txt ──────────────────────────────────────────────────────────────

app.get('/api/txt', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).send('Consulta vacía');
  const qLimpio = limpiarQuery(q);

  try {
    const resultado = await procesarMensaje(qLimpio + ' txt');
    registrarConsulta(req.session.userId, req.session.usuario, qLimpio, 'txt', req.ip).catch(() => {});

    if (resultado && typeof resultado === 'object' && resultado.tipo === 'txt') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="resultados.txt"');
      return res.send(resultado.contenido);
    }

    const texto = typeof resultado === 'string'
      ? resultado
      : (resultado && resultado.contenido) ? resultado.contenido : String(resultado);
    const limpio = texto.replace(/```\n?/g, '').replace(/\*([^*]+)\*/g, '$1').replace(/_([^_]+)_/g, '$1');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="resultados.txt"');
    return res.send(limpio);
  } catch (err) {
    res.status(500).send('Error al generar TXT: ' + err.message);
  }
});

// ── Admin: gestión de usuarios ────────────────────────────────────────────────

app.get('/admin', (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/admin/usuarios', requireAuth, async (req, res) => {
  try {
    const usuarios = await listarUsuarios();
    res.json({ ok: true, usuarios });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: err.message });
  }
});

app.post('/api/admin/usuarios', requireAuth, async (req, res) => {
  const { usuario, password, nombre } = req.body;
  if (!usuario || !password) return res.status(400).json({ ok: false, mensaje: 'Usuario y contraseña requeridos' });
  try {
    const existe = await buscarUsuario(usuario);
    if (existe) return res.status(409).json({ ok: false, mensaje: 'El usuario ya existe' });
    const hash = await bcrypt.hash(password, 10);
    await crearUsuario(usuario, hash, nombre || usuario);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: err.message });
  }
});

app.post('/api/admin/usuarios/:id/toggle', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.session.userId) return res.status(400).json({ ok: false, mensaje: 'No puedes desactivar tu propia cuenta' });
  try {
    await toggleUsuario(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: err.message });
  }
});

// ── Estáticos (al final, sin auth) ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`Servidor de inventario en puerto ${PORT}`));

// ── HTML de setup ─────────────────────────────────────────────────────────────
function setupHtml(err) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Configuración inicial · Inventario</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
       background: #f0f2f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.card { background: white; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,.10);
        padding: 36px 40px; width: 100%; max-width: 380px; }
.logo { text-align: center; margin-bottom: 24px; }
.logo-icon { font-size: 2.4rem; display: block; margin-bottom: 8px; }
h1 { font-size: 1.15rem; color: #1a2535; font-weight: 700; }
p  { color: #637083; font-size: 0.84rem; margin-top: 5px; margin-bottom: 24px; }
label { display: block; font-size: 0.82rem; font-weight: 600; color: #445; margin-bottom: 5px; }
input { width: 100%; padding: 9px 13px; border: 2px solid #dde3ec; border-radius: 7px;
        font-size: 0.92rem; outline: none; background: #f8f9fb; margin-bottom: 14px; }
input:focus { border-color: #3a85d8; background: white; }
button { width: 100%; padding: 11px; background: #1a2535; color: white; border: none;
         border-radius: 7px; font-size: 0.95rem; font-weight: 600; cursor: pointer; }
button:hover { background: #253550; }
.err { color: #c0392b; font-size: 0.83rem; text-align: center; margin-bottom: 14px; background: #fdf2f2; padding: 8px; border-radius: 6px; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <span class="logo-icon">📦</span>
    <h1>Configuración inicial</h1>
    <p>Crea la primera cuenta de administrador</p>
  </div>
  ${err ? '<div class="err">Error al crear el usuario. Intenta de nuevo.</div>' : ''}
  <form method="POST" action="/setup">
    <label>Usuario</label>
    <input name="usuario" type="text" required autocomplete="off" placeholder="ej: admin" />
    <label>Contraseña</label>
    <input name="password" type="password" required placeholder="Mínimo 6 caracteres" />
    <label>Nombre completo</label>
    <input name="nombre" type="text" placeholder="Opcional" />
    <button type="submit">Crear cuenta y continuar</button>
  </form>
</div>
</body>
</html>`;
}
