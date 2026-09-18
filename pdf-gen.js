const PDFDocument = require('pdfkit');

// Estima el ancho natural de una tabla antes de crear el doc
function estimarAncho(columnas, filas, hs, bs, cellPad) {
  return columnas.reduce((tot, h, i) => {
    const hw = h.length * hs * 0.60 + cellPad * 2;
    const dw = filas.length > 0
      ? Math.max(...filas.map(r => String(r[i] ?? '').length * bs * 0.52 + cellPad * 2))
      : hw;
    return tot + Math.max(hw, dw);
  }, 0);
}

function generarPdfBuffer(pdfData, numero, cliente) {
  return new Promise((resolve, reject) => {
    const MARGIN   = 40;
    const CELL_PAD = 8;
    const isRaw = pdfData && typeof pdfData === 'object' && Array.isArray(pdfData.columnas);

    // ── Elegir orientación y tamaño de fuente ────────────────────────────────
    let landscape   = false;
    let HEADER_SIZE = 11;
    let BODY_SIZE   = 10;

    if (isRaw) {
      const { columnas, filas } = pdfData;
      // LETTER portrait usable: 612-80=532  landscape: 792-80=712
      const PW = { portrait: 532, landscape: 712 };
      const candidates = [
        { hs: 11, bs: 10, land: false },
        { hs: 10, bs:  9, land: false },
        { hs:  9, bs:  8, land: false },
        { hs: 11, bs: 10, land: true  },
        { hs: 10, bs:  9, land: true  },
        { hs:  9, bs:  8, land: true  },
        { hs:  8, bs:  7, land: true  },
      ];
      const chosen = candidates.find(c => {
        const pw = PW[c.land ? 'landscape' : 'portrait'];
        return estimarAncho(columnas, filas, c.hs, c.bs, CELL_PAD) <= pw * 1.05;
      }) || candidates[candidates.length - 1];

      landscape   = chosen.land;
      HEADER_SIZE = chosen.hs;
      BODY_SIZE   = chosen.bs;
    }

    // ── Crear documento ───────────────────────────────────────────────────────
    const doc = new PDFDocument({
      margin: MARGIN,
      size: 'LETTER',
      layout: landscape ? 'landscape' : 'portrait',
      bufferPages: true,
    });
    const buffers = [];
    doc.on('data', b => buffers.push(b));
    doc.on('end',  () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const PAGE_W      = doc.page.width - MARGIN * 2;
    const FOOTER_H    = 30;
    const PAGE_BOTTOM = doc.page.height - MARGIN - FOOTER_H - 8;
    const ROW_PAD     = 3;

    if (isRaw) {
      const { columnas, alineacion, filas } = pdfData;

      // Medir anchos reales con el doc ya creado
      const colWidthsNat = columnas.map((h, i) => {
        doc.font('Helvetica-Bold').fontSize(HEADER_SIZE);
        let w = doc.widthOfString(h) + CELL_PAD * 2;
        doc.font('Helvetica').fontSize(BODY_SIZE);
        for (const row of filas)
          w = Math.max(w, doc.widthOfString(String(row[i] ?? '')) + CELL_PAD * 2);
        return w;
      });

      const totalNat = colWidthsNat.reduce((a, b) => a + b, 0);
      const scale    = totalNat > PAGE_W ? PAGE_W / totalNat : 1;
      const colWidths = colWidthsNat.map(w => w * scale);

      function rowHeight(row) {
        doc.font('Helvetica').fontSize(BODY_SIZE);
        let h = BODY_SIZE + ROW_PAD * 2;
        for (let i = 0; i < row.length; i++) {
          const ch = doc.heightOfString(String(row[i] ?? ''), {
            width: Math.max(1, colWidths[i] - CELL_PAD * 2),
            lineGap: 0,
          }) + ROW_PAD * 2;
          h = Math.max(h, ch);
        }
        return h;
      }

      function drawHeader(y) {
        doc.font('Helvetica-Bold').fontSize(HEADER_SIZE);
        let x = MARGIN;
        for (let i = 0; i < columnas.length; i++) {
          doc.text(columnas[i], x + CELL_PAD, y + ROW_PAD, {
            width: Math.max(1, colWidths[i] - CELL_PAD * 2),
            align: alineacion[i] || 'left',
            lineBreak: false,
          });
          x += colWidths[i];
        }
        const lineY = y + HEADER_SIZE + ROW_PAD * 2 + 2;
        doc.moveTo(MARGIN, lineY).lineTo(MARGIN + PAGE_W, lineY).lineWidth(0.5).stroke();
        return lineY + 4;
      }

      let y = drawHeader(MARGIN);

      for (const row of filas) {
        const rh = rowHeight(row);
        if (y + rh > PAGE_BOTTOM) {
          doc.addPage();
          y = drawHeader(MARGIN);
        }
        let x = MARGIN;
        doc.font('Helvetica').fontSize(BODY_SIZE);
        for (let i = 0; i < row.length; i++) {
          doc.text(String(row[i] ?? ''), x + CELL_PAD, y + ROW_PAD, {
            width: Math.max(1, colWidths[i] - CELL_PAD * 2),
            align: alineacion[i] || 'left',
            lineGap: 0,
          });
          x += colWidths[i];
        }
        y += rh;
      }

      if (pdfData.totalRow) {
        const tr = pdfData.totalRow;
        const trh = BODY_SIZE + ROW_PAD * 2;
        if (y + 6 + trh > PAGE_BOTTOM) {
          doc.addPage();
          y = drawHeader(MARGIN);
        }
        doc.moveTo(MARGIN, y + 2).lineTo(MARGIN + PAGE_W, y + 2).lineWidth(0.5).stroke();
        y += 6;
        let x = MARGIN;
        doc.font('Helvetica-Bold').fontSize(BODY_SIZE);
        for (let i = 0; i < tr.length; i++) {
          doc.text(String(tr[i] ?? ''), x + CELL_PAD, y + ROW_PAD, {
            width: Math.max(1, colWidths[i] - CELL_PAD * 2),
            align: alineacion[i] || 'left',
            lineGap: 0,
          });
          x += colWidths[i];
        }
      }

    } else {
      doc.font('Courier').fontSize(8);
      const lineH = 9.6;
      const lineas = (typeof pdfData === 'string' ? pdfData : '').replace(/─/g, '-').split('\n');
      for (const linea of lineas) {
        if (doc.y + lineH > PAGE_BOTTOM) doc.addPage();
        doc.text(linea || ' ', MARGIN, doc.y, { lineBreak: false });
        doc.y += lineH;
      }
    }

    // ── Footer en cada página ────────────────────────────────────────────────
    const total = doc.bufferedPageRange().count;
    const now   = new Date();
    const dd    = String(now.getDate()).padStart(2, '0');
    const mm    = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy  = now.getFullYear();
    const hh    = String(now.getHours()).padStart(2, '0');
    const mn    = String(now.getMinutes()).padStart(2, '0');
    const ss    = String(now.getSeconds()).padStart(2, '0');
    const fecha = `${dd}/${mm}/${yyyy}`;
    const hora  = `${hh}:${mn}:${ss}`;
    const nd    = String(numero || '').replace(/\D/g, '');
    const numGuiones = nd.length === 12
      ? `${nd.slice(0,2)}-${nd.slice(2,3)}-${nd.slice(3,7)}-${nd.slice(7)}`
      : nd.length === 10
        ? `${nd.slice(0,3)}-${nd.slice(3,6)}-${nd.slice(6)}`
        : nd.replace(/(\d{4})(?=\d)/g, '$1-') || (numero || '');
    const quarter = PAGE_W / 4;

    for (let i = 0; i < total; i++) {
      doc.switchToPage(i);
      const labelY = doc.page.height - MARGIN - FOOTER_H;
      const valueY = labelY + 13;
      doc.moveTo(MARGIN, labelY - 4).lineTo(MARGIN + PAGE_W, labelY - 4).lineWidth(0.3).stroke();
      doc.font('Helvetica-Bold').fontSize(9);
      doc.text('Fecha de Creación',   MARGIN,               labelY, { width: quarter, align: 'left',   lineBreak: false });
      doc.text('Hora de Creación',    MARGIN + quarter,     labelY, { width: quarter, align: 'left',   lineBreak: false });
      const clienteLabel = cliente ? 'Cliente' : 'Número Solicitado';
      const clienteValor = cliente ? String(cliente) : numGuiones;
      doc.text(clienteLabel,          MARGIN + quarter * 2, labelY, { width: quarter, align: 'center', lineBreak: false });
      doc.text('Página',              MARGIN + quarter * 3, labelY, { width: quarter, align: 'right',  lineBreak: false });
      doc.font('Helvetica').fontSize(10);
      doc.text(fecha,                 MARGIN,               valueY, { width: quarter, align: 'left',   lineBreak: false });
      doc.text(hora,                  MARGIN + quarter,     valueY, { width: quarter, align: 'left',   lineBreak: false });
      doc.text(clienteValor,          MARGIN + quarter * 2, valueY, { width: quarter, align: 'center', lineBreak: false });
      doc.text(`${i + 1} / ${total}`, MARGIN + quarter * 3, valueY, { width: quarter, align: 'right',  lineBreak: false });
    }

    doc.flushPages();
    doc.end();
  });
}

module.exports = { generarPdfBuffer };
