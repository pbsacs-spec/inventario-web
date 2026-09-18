require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path    = require('path');
const { procesarMensaje } = require('./consulta-keywords');
const { generarPdfBuffer } = require('./pdf-gen');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function limpiarQuery(q) {
  return q
    .replace(/\b(pdf|txt|bajar|descargar|exportar|archivo)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// POST /api/consulta
app.post('/api/consulta', (req, res) => {
  const q = (req.body.q || '').trim();
  if (!q) return res.json({ tipo: 'error', mensaje: 'Consulta vacía' });

  const qLimpio = limpiarQuery(q);

  try {
    const resultado = procesarMensaje(qLimpio + ' pdf');

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

// GET /api/pdf?q=...
app.get('/api/pdf', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).send('Consulta vacía');

  const qLimpio = limpiarQuery(q);

  try {
    const resultado = procesarMensaje(qLimpio + ' pdf');

    if (!resultado || typeof resultado !== 'object' || resultado.tipo !== 'pdf') {
      return res.status(400).send('La consulta no generó datos exportables');
    }

    const buf = await generarPdfBuffer(resultado.rawData || resultado.contenido, 'WEB', '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="resultados.pdf"');
    res.send(buf);
  } catch (err) {
    res.status(500).send('Error al generar PDF: ' + err.message);
  }
});

// GET /api/txt?q=...
app.get('/api/txt', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).send('Consulta vacía');

  const qLimpio = limpiarQuery(q);

  try {
    const resultado = procesarMensaje(qLimpio + ' txt');

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

app.listen(PORT, () => {
  console.log(`Servidor de inventario en puerto ${PORT}`);
});
