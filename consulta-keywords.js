const {
  consultarExistencias,
  resumenPorCategoria,
  listarCategorias,
  limpiarCache,
  buscarClientes,
} = require('./dbf-reader');

// ── Extracción de parámetros ─────────────────────────────────────────────────

function norm(texto) {
  return texto.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function extraerLugar(t) {
  if (/\bGENERAL\b/.test(t)) return 'GENERAL';
  if (/\bCONSIG\b/.test(t)) return 'CONSIG';
  if (/SEG.?MANO/.test(t)) return 'SEG MANO';
  return null;
}

function extraerLugares(t) {
  const matches = [];
  for (const m of t.matchAll(/\b(GENERAL|CONSIG|SEG\s*MANO)\b/g)) {
    const nombre = m[1].replace(/\s+/, ' ');
    if (!matches.includes(nombre)) matches.push(nombre);
  }
  return matches;
}

function limpiarTermino(texto) {
  return texto
    .replace(/\s+(en\s+)?(GENERAL|CONSIG|SEG\s*MANO)\b.*/i, '')
    .replace(/\s+(con\s+)?(existencia|existencias|stock|disponible|positiv)\b.*/i, '')
    .replace(/\s+(en\s+)?(almacen|almacén)\b.*/i, '')
    .replace(/\s+piezas\b.*/i, '')
    .replace(/\s+(bajar|descargar|exportar|archivo|txt|pdf)\b.*/i, '')
    .trim();
}

// ── Helpers de tabla ─────────────────────────────────────────────────────────

function col(str, len) {
  return String(str ?? '').substring(0, len).padEnd(len);
}

function fmtNum(n) {
  const parts = n.toFixed(1).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

function tabla(lineas) {
  if (lineas.length > 10000) {
    const extra = lineas.length - 10000;
    return '```\n' + lineas.slice(0, 10000).join('\n') + '\n```\n_...y ' + extra + ' líneas más_';
  }
  return '```\n' + lineas.join('\n') + '\n```';
}

function extraerContenidoPlano(respuesta) {
  if (typeof respuesta !== 'string' || respuesta.startsWith('⚠️')) return null;
  let contenido = respuesta;
  if (contenido.startsWith('```\n')) {
    contenido = contenido.slice(4);
    const fin = contenido.lastIndexOf('\n```');
    if (fin !== -1) contenido = contenido.slice(0, fin);
  }
  return contenido;
}

function comoTxt(respuesta) {
  const contenido = extraerContenidoPlano(respuesta);
  if (contenido === null) return respuesta;
  return { tipo: 'txt', nombre: 'resultados.txt', contenido };
}

function comoPdf(respuesta) {
  const contenido = extraerContenidoPlano(respuesta);
  if (contenido === null) return respuesta;
  return { tipo: 'pdf', nombre: 'resultados.pdf', contenido };
}

// ── Formateadores ────────────────────────────────────────────────────────────

function formatearExistencias(resultados, rawData = false) {
  if (!resultados.length) return '⚠️ No se encontraron existencias.';

  const porProducto = {};
  for (const r of resultados) {
    if (!porProducto[r.cve_prod]) {
      porProducto[r.cve_prod] = { desc: r.descripcion, filas: [] };
    }
    porProducto[r.cve_prod].filas.push(r);
  }

  const dw = Math.max(11, ...resultados.map(r => (r.descripcion || '').length));
  const totalMetros = resultados.reduce((sum, r) => sum + (r.existencia || 0), 0);
  const totalStr = fmtNum(totalMetros);

  const filasDatos = [];
  for (const [cve, { desc, filas }] of Object.entries(porProducto)) {
    for (const f of filas) {
      filasDatos.push({ cve, desc, metros: fmtNum(f.existencia) });
    }
  }

  if (rawData) {
    return {
      columnas:   ['CÓDIGO', 'DESCRIPCIÓN', 'METROS'],
      alineacion: ['left', 'left', 'right'],
      filas:      filasDatos.map(f => [f.cve, f.desc, f.metros]),
      totalRow:   ['', 'TOTAL', totalStr],
    };
  }

  const mw = Math.max(6, totalStr.length, ...filasDatos.map(f => f.metros.length));
  const lineas = [col('CÓDIGO', 12) + ' ' + col('DESCRIPCIÓN', dw) + ' ' + 'METROS'.padStart(mw)];
  lineas.push('─'.repeat(12 + 1 + dw + 1 + mw));
  for (const { cve, desc, metros } of filasDatos) {
    lineas.push(col(cve, 12) + ' ' + col(desc, dw) + ' ' + metros.padStart(mw));
  }
  lineas.push('─'.repeat(12 + 1 + dw + 1 + mw));
  lineas.push(col('', 12) + ' ' + col('TOTAL', dw) + ' ' + totalStr.padStart(mw));
  return tabla(lineas);
}

function formatearResumen(categorias, rawData = false) {
  if (!categorias.length) return '⚠️ No hay datos.';

  const tienePiezas   = categorias.some(c => c.total_piezas > 0);
  const totalMetros   = categorias.reduce((sum, c) => sum + (c.total_existencia || 0), 0);
  const totalPiezas   = tienePiezas ? categorias.reduce((sum, c) => sum + (c.total_piezas || 0), 0) : 0;
  const totalMetrosStr = fmtNum(totalMetros);

  const cw = Math.max(5, ...categorias.map(c => (c.cse_prod || '').length));
  const mw = Math.max(6, totalMetrosStr.length, ...categorias.map(c => fmtNum(c.total_existencia).length));
  const pw = tienePiezas ? Math.max(4, String(totalPiezas).length, ...categorias.map(c => String(c.total_piezas).length)) : 0;
  const nw = Math.max(5, ...categorias.map(c => String(c.num_productos).length));

  if (rawData) {
    const cols = tienePiezas ? ['CATEG', 'METROS', 'PZAS', 'PRODS'] : ['CATEG', 'METROS', 'PRODS'];
    const alin = tienePiezas ? ['left', 'right', 'right', 'right'] : ['left', 'right', 'right'];
    const filas = categorias.map(c => {
      const row = [c.cse_prod, fmtNum(c.total_existencia)];
      if (tienePiezas) row.push(String(c.total_piezas));
      row.push(String(c.num_productos));
      return row;
    });
    const totalRow = ['TOTAL', totalMetrosStr];
    if (tienePiezas) totalRow.push(String(totalPiezas));
    totalRow.push('');
    return { columnas: cols, alineacion: alin, filas, totalRow };
  }

  let header = col('CATEG', cw) + ' ' + 'METROS'.padStart(mw);
  if (tienePiezas) header += ' ' + 'PZAS'.padStart(pw);
  header += ' ' + 'PRODS'.padStart(nw);

  const lineas = [header, '─'.repeat(header.length)];
  for (const c of categorias) {
    let linea = col(c.cse_prod, cw) + ' ' + fmtNum(c.total_existencia).padStart(mw);
    if (tienePiezas) linea += ' ' + String(c.total_piezas).padStart(pw);
    linea += ' ' + String(c.num_productos).padStart(nw);
    lineas.push(linea);
  }
  let totalLinea = col('TOTAL', cw) + ' ' + totalMetrosStr.padStart(mw);
  if (tienePiezas) totalLinea += ' ' + String(totalPiezas).padStart(pw);
  totalLinea += ' ' + ''.padStart(nw);
  lineas.push('─'.repeat(header.length));
  lineas.push(totalLinea);
  return tabla(lineas);
}

async function formatearComparacionProductos(params, lugares, rawData = false) {
  const porProducto = {};
  for (const lugar of lugares) {
    const rows = await consultarExistencias({ ...params, lugar });
    for (const r of rows) {
      if (!porProducto[r.cve_prod]) {
        porProducto[r.cve_prod] = { desc: r.descripcion, almacenes: {} };
      }
      porProducto[r.cve_prod].almacenes[lugar] = { existencia: r.existencia };
    }
  }

  if (!Object.keys(porProducto).length) return '⚠️ No se encontraron existencias.';

  const abrev  = l => l;
  const dw     = Math.max(11, ...Object.values(porProducto).map(({ desc }) => (desc || '').length));
  const totalesPorLugar = lugares.map(l =>
    Object.values(porProducto).reduce((sum, { almacenes }) => sum + (almacenes[l] ? almacenes[l].existencia : 0), 0)
  );
  const totalStrs = totalesPorLugar.map(fmtNum);
  const filasDatos = Object.entries(porProducto).map(([cve, { desc, almacenes }]) => ({
    cve, desc,
    vals: lugares.map(l => almacenes[l] ? fmtNum(almacenes[l].existencia) : '0.0'),
  }));

  if (rawData) {
    return {
      columnas:   ['CÓDIGO', 'DESCRIPCIÓN', ...lugares.map(abrev)],
      alineacion: ['left', 'left', ...lugares.map(() => 'right')],
      filas:      filasDatos.map(f => [f.cve, f.desc, ...f.vals]),
      totalRow:   ['', 'TOTAL', ...totalStrs],
    };
  }

  const cws = lugares.map((l, i) => Math.max(abrev(l).length, totalStrs[i].length, ...filasDatos.map(f => f.vals[i].length)));
  const lineas = [col('CÓDIGO', 12) + ' ' + col('DESCRIPCIÓN', dw) + ' ' + lugares.map((l, i) => abrev(l).padStart(cws[i])).join(' ')];
  lineas.push('─'.repeat(12 + 1 + dw + 1 + cws.reduce((a, b) => a + b + 1, 0) - 1));
  for (const { cve, desc, vals } of filasDatos) {
    lineas.push(col(cve, 12) + ' ' + col(desc, dw) + ' ' + vals.map((v, i) => v.padStart(cws[i])).join(' '));
  }
  lineas.push('─'.repeat(12 + 1 + dw + 1 + cws.reduce((a, b) => a + b + 1, 0) - 1));
  lineas.push(col('', 12) + ' ' + col('TOTAL', dw) + ' ' + totalStrs.map((v, i) => v.padStart(cws[i])).join(' '));
  return tabla(lineas);
}

async function formatearComparacion(lugares, soloPositivos, rawData = false) {
  const datos = {};
  for (const lugar of lugares) {
    const rows = await resumenPorCategoria({ lugar, solo_positivos: soloPositivos });
    for (const r of rows) {
      if (!datos[r.cse_prod]) datos[r.cse_prod] = {};
      datos[r.cse_prod][lugar] = r.total_existencia;
    }
  }

  const categorias = Object.entries(datos)
    .map(([cse, vals]) => ({ cse, total: Object.values(vals).reduce((a, b) => a + b, 0), vals }))
    .sort((a, b) => b.total - a.total);

  if (!categorias.length) return '⚠️ No hay datos.';

  const abrev = l => l;
  const totalesPorLugar = lugares.map(l => Object.values(datos).reduce((sum, vals) => sum + (vals[l] || 0), 0));
  const totalStrs = totalesPorLugar.map(fmtNum);
  const filasDatos = categorias.map(({ cse, vals }) => ({ cse, vals: lugares.map(l => fmtNum(vals[l] || 0)) }));

  if (rawData) {
    return {
      columnas:   ['CATEG', ...lugares.map(abrev)],
      alineacion: ['left', ...lugares.map(() => 'right')],
      filas:      filasDatos.map(f => [f.cse, ...f.vals]),
      totalRow:   ['TOTAL', ...totalStrs],
    };
  }

  const cw  = Math.max(5, ...filasDatos.map(f => f.cse.length));
  const cws = lugares.map((l, i) => Math.max(abrev(l).length, totalStrs[i].length, ...filasDatos.map(f => f.vals[i].length)));
  const header = col('CATEG', cw) + ' ' + lugares.map((l, i) => abrev(l).padStart(cws[i])).join(' ');
  const lineas = [header, '─'.repeat(header.length)];
  for (const { cse, vals } of filasDatos) {
    lineas.push(col(cse, cw) + ' ' + vals.map((v, i) => v.padStart(cws[i])).join(' '));
  }
  lineas.push('─'.repeat(header.length));
  lineas.push(col('TOTAL', cw) + ' ' + totalStrs.map((v, i) => v.padStart(cws[i])).join(' '));
  return tabla(lineas);
}

function formatearAyuda() {
  return `*Consultas disponibles:*

🔍 Código: _0282LISBCO_
🔍 Categoría: _0282_ o _categoría 0282_
🔍 Buscar: _busca organza_
👤 Cliente: _cliente metropolitana_ o _busca cliente 1_
📊 Resumen: _resumen_
📋 Categorías: _categorías_
💾 Exportar TXT: agrega _bajar_ o _txt_ a cualquier consulta
📄 Exportar PDF: agrega _pdf_ a cualquier consulta

Filtra por almacén agregando: _en GENERAL_ o _en CONSIG_`;
}

function formatearClientes(rows, comoPdfFlag) {
  if (!rows.length) return '⚠️ No se encontraron clientes.';

  const columnas   = ['CVE', 'NOMBRE', 'CRÉDITO', 'DÍAS'];
  const alineacion = ['right', 'left', 'right', 'right'];
  const filas = rows.map(r => [
    r.cve_cte,
    (r.nom_cte || '').substring(0, 65),
    r.lim_cre ? (() => { const p = parseFloat(r.lim_cre).toFixed(2).split('.'); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); return p.join('.'); })() : '',
    r.dia_cre || '',
  ]);

  if (comoPdfFlag) {
    return { tipo: 'pdf', nombre: 'clientes.pdf', rawData: { columnas, alineacion, filas } };
  }

  const cw  = Math.max(3, ...filas.map(f => String(f[0]).length));
  const nw  = Math.max(6, ...filas.map(f => String(f[1]).length));
  const crw = Math.max(7, ...filas.map(f => String(f[2]).length));
  const dw  = Math.max(4, ...filas.map(f => String(f[3]).length));
  const sep = '─'.repeat(cw + nw + crw + dw + 6);
  const hdr = String('CVE').padStart(cw) + '  ' + 'NOMBRE'.padEnd(nw) + '  ' +
              'CRÉDITO'.padStart(crw) + '  ' + 'DÍAS'.padStart(dw);
  const lineas = [sep, hdr, sep];
  for (const f of filas) {
    lineas.push(String(f[0]).padStart(cw) + '  ' + String(f[1]).padEnd(nw) + '  ' +
                String(f[2]).padStart(crw) + '  ' + String(f[3]).padStart(dw));
  }
  lineas.push(sep, `Total: ${rows.length} clientes`);
  return tabla(lineas);
}

// ── Procesador principal ─────────────────────────────────────────────────────

async function procesarMensaje(texto) {
  const t = norm(texto);
  const lugar = extraerLugar(t) || 'GENERAL';
  const soloPositivos = true;
  const comoArchivo = /\bBAJA(R)?\b|\bDESCARGA(R)?\b|\bARCHIVO\b|\bTXT\b|\bEXPORTA(R)?\b/.test(t);
  const comoPdfFlag = /\bPDF\b/.test(t);
  const ret = r => {
    if (comoPdfFlag) {
      if (r && typeof r === 'object' && Array.isArray(r.columnas)) {
        return { tipo: 'pdf', nombre: 'resultados.pdf', rawData: r };
      }
      return comoPdf(r);
    }
    return comoArchivo ? comoTxt(r) : r;
  };

  // Clientes
  const cteMatch = texto.match(/\b(?:busca\s+)?cliente[s]?\s*(.*)/i);
  if (cteMatch !== null) {
    const termRaw = cteMatch[1].replace(/\b(pdf|txt|bajar|descargar|exportar|archivo)\b/gi, '').trim();
    const esCve   = /^\d+$/.test(termRaw);
    try {
      const rows = await buscarClientes(esCve ? { cve_cte: termRaw } : { termino: termRaw || null });
      return formatearClientes(rows, comoPdfFlag);
    } catch (err) {
      return `❌ Error al buscar clientes: ${err.message}`;
    }
  }

  // Ayuda
  if (/\bAYUDA\b|\bHELP\b|\bCOMO\b|\bCOMANDOS\b/.test(t)) {
    return formatearAyuda();
  }

  // Listar categorías
  const tieneCodigo4d = /\b\d{4}\b/.test(texto);
  if (/\bCATEGOR(IA|IAS)\b/.test(t) && !tieneCodigo4d && !/\bRESUMEN\b/.test(t)) {
    const lista = await listarCategorias();
    return `*Categorías (${lista.length}):*\n${lista.join(', ')}`;
  }

  // Resumen
  if (/\bRESUMEN\b|\bTOTALES?\b|\bAGRUPAD/.test(t)) {
    const lugares = extraerLugares(t);
    if (lugares.length >= 2) {
      return ret(await formatearComparacion(lugares, soloPositivos, comoPdfFlag));
    }
    return ret(formatearResumen(await resumenPorCategoria({ lugar, solo_positivos: soloPositivos }), comoPdfFlag));
  }

  // Código de producto: 4 dígitos + letras (ej: 0282LISBCO)
  const cveMatch = texto.match(/\b(\d{4}[A-Za-z][A-Za-z0-9]{2,})\b/);
  if (cveMatch) {
    const cve_prod = cveMatch[1].toUpperCase();
    const lugares  = extraerLugares(t);
    if (lugares.length >= 2) {
      return ret(await formatearComparacionProductos({ cve_prod, solo_positivos: soloPositivos }, lugares, comoPdfFlag));
    }
    return ret(formatearExistencias(await consultarExistencias({ cve_prod, lugar }), comoPdfFlag));
  }

  // Búsqueda explícita
  const busqMatch = texto.match(/\b(?:busca|busco|buscar|busqueda|búsqueda)\s+(.+)/i);
  if (busqMatch) {
    const termRaw      = limpiarTermino(busqMatch[1]);
    const catEnBusqueda = termRaw.match(/\b(\d{4})\b/);
    const cse_en_busq  = catEnBusqueda ? catEnBusqueda[1] : null;
    const busqueda     = termRaw.replace(/\s*\b\d{4}\b\s*/g, ' ').trim();
    if (busqueda || cse_en_busq) {
      const params = { solo_positivos: soloPositivos };
      if (busqueda)   params.busqueda  = busqueda;
      if (cse_en_busq) params.cse_prod = cse_en_busq;
      const lugares = extraerLugares(t);
      if (lugares.length >= 2) {
        return ret(await formatearComparacionProductos(params, lugares, comoPdfFlag));
      }
      return ret(formatearExistencias(await consultarExistencias({ ...params, lugar }), comoPdfFlag));
    }
  }

  // Categoría: solo 4 dígitos
  const catMatch = texto.match(/\b(\d{4})\b/);
  if (catMatch) {
    const cse_prod = catMatch[1];
    const lugares  = extraerLugares(t);
    if (lugares.length >= 2) {
      return ret(await formatearComparacionProductos({ cse_prod, solo_positivos: soloPositivos }, lugares, comoPdfFlag));
    }
    return ret(formatearExistencias(await consultarExistencias({ cse_prod, lugar, solo_positivos: soloPositivos }), comoPdfFlag));
  }

  // Búsqueda implícita
  const limpio = texto.trim();
  if (limpio.length >= 3) {
    const termino = limpiarTermino(limpio);
    if (termino) {
      const lugares = extraerLugares(t);
      if (lugares.length >= 2) {
        return ret(await formatearComparacionProductos({ busqueda: termino, solo_positivos: soloPositivos }, lugares, comoPdfFlag));
      }
      const rows = await consultarExistencias({ busqueda: termino, lugar, solo_positivos: soloPositivos });
      return ret(formatearExistencias(rows, comoPdfFlag));
    }
  }

  return formatearAyuda();
}

module.exports = { procesarMensaje };
