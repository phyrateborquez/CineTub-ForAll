const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const config = require('../config');

// Cliente de Turso (libSQL) — se inicializa una sola vez
let client = null;

/**
 * Inicializa la conexión al cliente libSQL.
 * En producción usa Turso (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN).
 * En desarrollo usa un archivo SQLite local como fallback.
 */
async function initDatabase() {
  if (config.tursoUrl && config.tursoAuthToken) {
    // Modo producción: Turso en la nube
    client = createClient({
      url: config.tursoUrl,
      authToken: config.tursoAuthToken,
    });
    console.log('[db] Conectado a Turso (remoto)');
  } else {
    // Modo desarrollo: SQLite local via libSQL (mismo driver, sin red)
    const dataDir = path.dirname(config.dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    client = createClient({ url: pathToFileURL(path.resolve(config.dbPath)).href });
    console.log('[db] Conectado a SQLite local:', config.dbPath);
  }

  // Ejecutar migración: separar los statements y ejecutarlos uno por uno
  // (más robusto que executeMultiple que puede fallar dependiendo de la versión)
  const migrationPath = path.join(__dirname, 'migrations', '001_initial.sql');
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const statements = migration
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const statement of statements) {
    await client.execute(statement);
  }

  console.log('[db] Migraciones aplicadas correctamente');
  return client;
}

// Obtener el cliente (falla si no fue inicializado)
function getDb() {
  if (!client) {
    throw new Error('Base de datos no inicializada. Llama a initDatabase() primero.');
  }
  return client;
}

/**
 * Ejecuta una query de escritura (INSERT, UPDATE, DELETE).
 * @returns {ResultSet} resultado con lastInsertRowid, rowsAffected
 */
async function run(sql, params = []) {
  return client.execute({ sql, args: params });
}

function batch(statements) {
  return getDb().batch(statements, 'write');
}

function close() {
  client?.close();
  client = null;
}

/**
 * Convierte una Row de libSQL a un objeto JS plano.
 * libSQL rows soportan acceso por nombre de columna y por índice.
 */
function _rowToObject(row, columns) {
  const obj = {};
  for (const col of columns) {
    // Acceso por nombre de columna — garantizado en @libsql/client
    obj[col] = row[col] !== undefined ? row[col] : row[columns.indexOf(col)];
  }
  return obj;
}

/**
 * Obtiene la primera fila del resultado, o null si no hay resultados.
 */
async function get(sql, params = []) {
  const result = await client.execute({ sql, args: params });
  if (!result.rows || result.rows.length === 0) return null;
  return _rowToObject(result.rows[0], result.columns);
}

/**
 * Obtiene todas las filas del resultado mapeadas a objetos JS planos.
 */
async function all(sql, params = []) {
  const result = await client.execute({ sql, args: params });
  if (!result.rows || result.rows.length === 0) return [];
  return result.rows.map(row => _rowToObject(row, result.columns));
}

module.exports = {
  initDatabase,
  getDb,
  run,
  get,
  all,
  batch,
  close,
};
