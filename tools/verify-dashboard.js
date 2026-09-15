#!/usr/bin/env node
/*
  Verificador de sintaxis del dashboard.

  Compila el bloque <script type="text/babel"> de public/dashboard-app.html con
  EL MISMO Babel que usa el navegador y con la misma configuracion de presets,
  y reporta los errores con el numero de linea DEL ARCHIVO -- no del bloque
  interno, que es lo que muestra la consola del navegador y obliga a hacer
  cuentas a mano.

  La version de Babel NO esta escrita aqui: se lee del propio HTML, del atributo
  src del <script> de @babel/standalone. Asi el verificador siempre usa
  exactamente la version que se sirve a los usuarios, incluso si se cambia el
  pin en el HTML.

  Uso:
    npm run verify
    node --use-system-ca tools/verify-dashboard.js
    node --use-system-ca tools/verify-dashboard.js ruta/a/otro.html

  Salida:
    codigo 0  ->  compila
    codigo 1  ->  error de sintaxis (imprime archivo:linea:columna y contexto)
    codigo 2  ->  no se pudo preparar la verificacion

  Nota sobre TLS corporativo: usar --use-system-ca para que Node confie en los
  certificados de la maquina. Sin ese flag, la descarga de Babel puede fallar
  con UNABLE_TO_GET_ISSUER_CERT_LOCALLY.
*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(__dirname, '.cache');

const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(PROJECT_ROOT, 'public', 'dashboard-app.html');

function fail(message) {
  console.error('No se pudo verificar: ' + message);
  process.exit(2);
}

if (!fs.existsSync(target)) {
  fail('no existe ' + target);
}

const raw = fs.readFileSync(target, 'utf8');
const fileLines = raw.split(/\r?\n/);

/* ── 1. Localizar el bloque JSX ──────────────────────────────────────────── */

const tagIndex = raw.indexOf('<script type="text/babel">');

if (tagIndex < 0) {
  fail('no se encontro un <script type="text/babel"> en ' + target);
}

const contentStart = raw.indexOf('>', tagIndex) + 1;
const contentEnd = raw.lastIndexOf('</' + 'script>');
const jsx = raw.slice(contentStart, contentEnd);

/* Linea del archivo donde empieza el contenido del bloque. Babel cuenta desde
   1 dentro del bloque, asi que este es el desplazamiento para traducir. */
const blockStartLine = raw.slice(0, contentStart).split(/\r?\n/).length;

/* ── 2. Averiguar que Babel usa el navegador ─────────────────────────────── */

const babelSrc = /<script[^>]+src="([^"]*@babel\/standalone[^"]*)"/.exec(raw);

if (!babelSrc) {
  fail('no se encontro el <script> de @babel/standalone en el HTML');
}

const babelUrl = babelSrc[1];
const pinned = /@babel\/standalone@([^/]+)\//.exec(babelUrl);

if (!pinned) {
  fail(
    'el <script> de @babel/standalone no tiene la version fijada:\n'
    + '  ' + babelUrl + '\n'
    + '  Fijala (por ejemplo @babel/standalone@8.0.5) antes de verificar.'
  );
}

const babelVersion = pinned[1];
const babelFile = path.join(CACHE_DIR, 'babel-' + babelVersion + '.min.js');

/* ── 3. Obtener Babel (cache local) ──────────────────────────────────────── */

async function ensureBabel() {
  if (fs.existsSync(babelFile)) {
    return;
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log('Descargando Babel ' + babelVersion + ' (una sola vez)...');

  const response = await fetch(babelUrl);

  if (!response.ok) {
    fail('la descarga de Babel devolvio HTTP ' + response.status);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(babelFile, bytes);

  console.log('  guardado en tools/.cache/ (' + bytes.length + ' bytes)');
}

function loadBabel() {
  const sandbox = {
    window: {}, self: {}, console,
    setTimeout, clearTimeout, Date, Math, JSON
  };

  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(babelFile, 'utf8'), sandbox, {
    filename: babelFile,
    timeout: 180000
  });

  return sandbox.Babel || sandbox.window.Babel;
}

/* ── 4. Compilar y reportar ──────────────────────────────────────────────── */

function report(error) {
  const message = String(error.message).split('\n')[0];
  const position = /\((\d+):(\d+)\)\s*$/.exec(message);

  console.error('');
  console.error('ERROR DE SINTAXIS');
  console.error('  ' + message.replace(/\s*\(\d+:\d+\)\s*$/, ''));

  if (!position) {
    console.error('  (Babel no indico una posicion)');
    return;
  }

  const fileLine = blockStartLine + Number(position[1]) - 1;
  const column = Number(position[2]) + 1;

  console.error('');
  console.error('  --> ' + path.relative(PROJECT_ROOT, target)
    + ':' + fileLine + ':' + column);
  console.error('');

  for (let n = fileLine - 4; n <= fileLine + 4; n++) {
    if (n < 1 || n > fileLines.length) {
      continue;
    }

    console.error(
      (n === fileLine ? ' >' : '  ')
      + String(n).padStart(6) + ' | '
      + fileLines[n - 1]
    );
  }

  console.error('');
}

(async () => {
  await ensureBabel();

  const Babel = loadBabel();

  if (!Babel) {
    fail('el bundle de Babel no expuso el objeto global Babel');
  }

  const started = Date.now();

  try {
    /* Configuracion identica a la que aplica @babel/standalone a un
       <script type="text/babel"> sin data-presets. */
    const output = Babel.transform(jsx, {
      filename: 'Inline Babel script',
      presets: [['react', { runtime: 'classic' }], 'env'],
      sourceMaps: 'inline',
      sourceFileName: 'Inline Babel script',
      targets: { browsers: undefined }
    });

    console.log('OK  ' + path.relative(PROJECT_ROOT, target)
      + ' compila sin errores de sintaxis.');
    console.log('    Babel ' + Babel.version
      + '  |  ' + fileLines.length + ' lineas'
      + '  |  ' + jsx.length + ' bytes de JSX'
      + '  ->  ' + output.code.length + ' bytes'
      + '  en ' + (Date.now() - started) + ' ms');

    process.exit(0);
  } catch (error) {
    report(error);
    process.exit(1);
  }
})();
