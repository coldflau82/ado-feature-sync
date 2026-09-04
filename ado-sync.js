require('dotenv').config();

const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const { DateTime } = require('luxon');

/*
  Zona horaria oficial del dashboard.

  Todas las reglas que trabajan con "día de negocio" usan esta zona:
  - Overdue;
  - Target Date near;
  - siguiente mes calendario;
  - rangos WIQL;
  - snapshots futuros;
  - fecha operativa mostrada al frontend.

  No usar process.env.TZ como fuente de verdad: esa variable modifica el
  proceso Node, pero no garantiza que el navegador ni Azure DevOps usen
  la misma interpretación temporal.
*/
const DASHBOARD_TIME_ZONE = String(
  process.env.DASHBOARD_TIME_ZONE || 'America/Chicago'
).trim();

const dashboardZoneValidation = DateTime.now().setZone(
  DASHBOARD_TIME_ZONE
);

if (!dashboardZoneValidation.isValid) {
  throw new Error(
    'Invalid DASHBOARD_TIME_ZONE. Use a valid IANA timezone, ' +
    'for example: America/Chicago.'
  );
}

/* Azure DevOps es una dependencia obligatoria del dashboard. Validar al iniciar evita que la aplicación arranque aparentemente bien
  y falle después durante una solicitud con una URL o credenciales inválidas. */
const REQUIRED_ADO_ENV_VARS = [
  'ADO_ORG',
  'ADO_PROJECT',
  'ADO_PAT'
];

const missingAdoEnvVars = REQUIRED_ADO_ENV_VARS.filter(
  envVar => !String(process.env[envVar] || '').trim()
);

if (missingAdoEnvVars.length > 0) {
  throw new Error(
    `Missing required Azure DevOps environment variable(s): ` +
    missingAdoEnvVars.join(', ')
  );
}

/* El endpoint de sincronización interna no debe quedar expuesto. En Vercel, CRON_SECRET permite que la plataforma envíe la autorización 
automáticamente al invocar el Cron Job. También permite probar el endpoint manualmente de forma controlada. */
const CRON_SECRET = String(
  process.env.CRON_SECRET || ''
).trim();

if (!CRON_SECRET) {
  throw new Error(
    'Missing required environment variable: CRON_SECRET.'
  );
}

/* Reglas de negocio de Delivery Health. Ubicación: /config/delivery-health-rules.json */
let deliveryHealthRules;

try {
  deliveryHealthRules = require('./config/delivery-health-rules.json');
} catch (error) {
  throw new Error(
    'Unable to load config/delivery-health-rules.json. ' +
    'Verify that the file exists in the deployment and contains valid JSON. ' +
    `Original error: ${error.message}`
  );
}

/* Calendario técnico de Release Fix Versions. Ubicación: /config/release-calendar.json */
let releaseCalendar;

try {
  releaseCalendar = require('./config/release-calendar.json');
} catch (error) {
  throw new Error(
    'Unable to load config/release-calendar.json. ' +
    'Verify that the file exists in the deployment and contains valid JSON. ' +
    `Original error: ${error.message}`
  );
}

/*
  Valida la estructura mínima antes de aceptar reglas de negocio.
  Es preferible detener el servidor durante el arranque a calcular
  Delivery Health con una política incompleta o mal configurada.
*/
function validateDeliveryHealthRules(config) {
  const allowedGroups = new Set([
    'requires-action',
    'requires-attention',
    'healthy',
    'not-started'
  ]);

  const requiredRuleKeys = [
    'notStarted',
    'overdue',
    'targetDateNearUnscheduledDiscovery',
    'targetNextMonthWithoutRelease',
    'closedWithOpenWork',
    'needsEstimate',
    'noStories',
    'noActiveWork',
    'unestimatedWork',
    'healthy',
    'unableToEvaluate'
  ];

  const assertNonEmptyStringArray = (value, propertyPath) => {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some(
        item =>
          typeof item !== 'string' ||
          !item.trim()
      )
    ) {
      throw new Error(
        `Delivery Health configuration "${propertyPath}" ` +
        'must be a non-empty array of text values.'
      );
    }
  };

  const assertNonEmptyString = (value, propertyPath) => {
    if (
      typeof value !== 'string' ||
      !value.trim()
    ) {
      throw new Error(
        `Delivery Health configuration "${propertyPath}" ` +
        'must be a non-empty text value.'
      );
    }
  };

  if (!config || typeof config !== 'object') {
    throw new Error(
      'Delivery Health configuration must be a JSON object.'
    );
  }

  if (!Number.isInteger(config.version) || config.version < 1) {
    throw new Error(
      'Delivery Health configuration "version" must be a positive integer.'
    );
  }

  assertNonEmptyStringArray(
    config.workItemStates?.removed,
    'workItemStates.removed'
  );
  
  assertNonEmptyStringArray(
    config.workItemStates?.inPlanning,
    'workItemStates.inPlanning'
  );
  
  assertNonEmptyStringArray(
    config.workItemStates?.inProgress,
    'workItemStates.inProgress'
  );
  
  assertNonEmptyStringArray(
    config.workItemStates?.toRelease,
    'workItemStates.toRelease'
  );
  
  assertNonEmptyStringArray(
    config.workItemStates?.completed,
    'workItemStates.completed'
  );
  
  assertNonEmptyStringArray(
    config.workItemStates?.requiresEstimate,
    'workItemStates.requiresEstimate'
  );

    assertNonEmptyStringArray(
    config.featureStates?.execution,
    'featureStates.execution'
  );

  assertNonEmptyStringArray(
    config.featureStates?.closed,
    'featureStates.closed'
  );

  assertNonEmptyStringArray(
    config.featureStates?.notStarted,
    'featureStates.notStarted'
  );

  assertNonEmptyStringArray(
    config.featureStates?.noActiveWork,
    'featureStates.noActiveWork'
  );

  if (
    !Number.isInteger(config.thresholds?.targetDateNearDays) ||
    config.thresholds.targetDateNearDays < 1
  ) {
    throw new Error(
      'Delivery Health configuration "thresholds.targetDateNearDays" ' +
      'must be a positive integer.'
    );
  }

  if (
    !config.rules ||
    typeof config.rules !== 'object'
  ) {
    throw new Error(
      'Delivery Health configuration "rules" must be an object.'
    );
  }

  requiredRuleKeys.forEach(ruleKey => {
    const rule = config.rules[ruleKey];

    if (!rule || typeof rule !== 'object') {
      throw new Error(
        `Delivery Health configuration is missing rule "${ruleKey}".`
      );
    }

    if (typeof rule.enabled !== 'boolean') {
      throw new Error(
        `Delivery Health rule "${ruleKey}.enabled" must be true or false.`
      );
    }

    assertNonEmptyString(
      rule.group,
      `rules.${ruleKey}.group`
    );

    if (!allowedGroups.has(rule.group)) {
      throw new Error(
        `Delivery Health rule "${ruleKey}.group" has an invalid value: ` +
        `"${rule.group}".`
      );
    }

    assertNonEmptyString(
      rule.label,
      `rules.${ruleKey}.label`
    );

    assertNonEmptyString(
      rule.shortLabel,
      `rules.${ruleKey}.shortLabel`
    );

    if (!rule.reason && !rule.reasonTemplate) {
      throw new Error(
        `Delivery Health rule "${ruleKey}" must define ` +
        '"reason" or "reasonTemplate".'
      );
    }

    if (rule.reason) {
      assertNonEmptyString(
        rule.reason,
        `rules.${ruleKey}.reason`
      );
    }

    if (rule.reasonTemplate) {
      assertNonEmptyString(
        rule.reasonTemplate,
        `rules.${ruleKey}.reasonTemplate`
      );
    }

    assertNonEmptyString(
      rule.recommendedAction,
      `rules.${ruleKey}.recommendedAction`
    );
  });
}

validateDeliveryHealthRules(deliveryHealthRules);
validateReleaseCalendar(releaseCalendar);

/* Proyección del calendario para el navegador.
  El backend conserva la configuración completa y validada; el frontend recibe únicamente lo que necesita para:
  - Roadmap;
  - filtros/presets de RFV;
  - tooltips;
  - futuras comparaciones visuales. */
const releaseCalendarByRfv = Object.fromEntries(
  releaseCalendar.releases.map(release => [
    release.rfv,
    {
      date: release.date,
      sequence: release.sequence,
      label: release.label || release.rfv
    }
  ])
);

function validateReleaseCalendar(config) {
  if (!config || typeof config !== 'object') {
    throw new Error(
      'Release calendar configuration must be a JSON object.'
    );
  }

  if (!Number.isInteger(config.version) || config.version < 1) {
    throw new Error(
      'Release calendar configuration "version" must be a positive integer.'
    );
  }

  if (
    typeof config.timeZone !== 'string' ||
    !config.timeZone.trim()
  ) {
    throw new Error(
      'Release calendar configuration "timeZone" must be a non-empty string.'
    );
  }

  const calendarZone = DateTime.now().setZone(config.timeZone);

  if (!calendarZone.isValid) {
    throw new Error(
      'Release calendar configuration "timeZone" must be a valid IANA timezone.'
    );
  }

  if (!Array.isArray(config.releases) || config.releases.length === 0) {
    throw new Error(
      'Release calendar configuration "releases" must be a non-empty array.'
    );
  }

  const seenRfv = new Set();
  const seenSequence = new Set();

  config.releases.forEach((release, index) => {
    const prefix = `release-calendar.releases[${index}]`;

    if (
      !release ||
      typeof release !== 'object'
    ) {
      throw new Error(`${prefix} must be an object.`);
    }

    if (
      typeof release.rfv !== 'string' ||
      !release.rfv.trim()
    ) {
      throw new Error(`${prefix}.rfv must be a non-empty string.`);
    }

    if (
      typeof release.date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(release.date)
    ) {
      throw new Error(
        `${prefix}.date must use YYYY-MM-DD format.`
      );
    }

    const parsedDate = DateTime.fromISO(release.date, {
      zone: config.timeZone
    });

    if (!parsedDate.isValid) {
      throw new Error(
        `${prefix}.date is not a valid calendar date.`
      );
    }

    if (
      !Number.isInteger(release.sequence) ||
      release.sequence < 1
    ) {
      throw new Error(
        `${prefix}.sequence must be a positive integer.`
      );
    }

    if (seenRfv.has(release.rfv)) {
      throw new Error(
        `Release calendar contains duplicate RFV "${release.rfv}".`
      );
    }

    if (seenSequence.has(release.sequence)) {
      throw new Error(
        `Release calendar contains duplicate sequence "${release.sequence}".`
      );
    }

    seenRfv.add(release.rfv);
    seenSequence.add(release.sequence);
  });
}

function getDeliveryHealthRule(ruleKey) {
  return deliveryHealthRules.rules[ruleKey];
}

/* Reemplaza tokens simples de las razones dinámicas. Actualmente las reglas utilizan {count}; esta función permite agregar más tokens en el futuro sin volver a dispersar textos en server.js.*/
function formatDeliveryHealthReason(template, values = {}) {
  return String(template || '').replace(
    /\{([^}]+)\}/g,
    (match, key) =>
      Object.prototype.hasOwnProperty.call(values, key)
        ? String(values[key])
        : match
  );
}

const app = express();

/* Ruta oficial, sin extensión. Mantiene visible /dashboard-app y sirve el HTML real.*/
app.get('/dashboard-app', (req, res) => {
  res.sendFile(
    path.join(process.cwd(), 'public', 'dashboard-app.html')
  );
});

/* Rutas antiguas o alternativas. Redirigen el navegador a la URL oficial. */
app.get(['/', '/dashboard', '/dashboard.html', '/dashboard-app.html'], (req, res) => {
  res.redirect(307, '/dashboard-app');
});

app.use(express.json());

/* Para desarrollo local, sirve los archivos dentro de /public.
  En Vercel, los assets de /public se sirven directamente desde CDN. */
app.use(express.static(path.join(__dirname, 'public')));

const { Redis } = require('@upstash/redis');

// Cliente Redis (lee automáticamente las env vars si se llaman KV_REST_API_URL / KV_REST_API_TOKEN)
const redis = Redis.fromEnv();
// Si tus variables tienen otro nombre, usa:
// const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

// ===== Historiales ADO: protección contra throttling =====
// Máximo de consultas simultáneas a /revisions dentro de una solicitud batch.
// Empieza con 5; puede subirse gradualmente si ADO no devuelve 429.
const HISTORY_BATCH_CONCURRENCY = 5;

/* Máximo de consultas WIQL históricas simultáneas durante la creación del caché de Features antiguas.
Se inicia deliberadamente con 2 para reducir el tiempo de refresh sin generar una carga excesiva sobre Azure DevOps. No aumentar este valor
sin revisar primero logs de throttling HTTP 429. */
const OLD_FEATURES_RANGE_CONCURRENCY = 2;

/* Protección adicional para evitar solicitudes batch accidentalmente enormes.
El dashboard actual manda como máximo 15 IDs por página.*/
const MAX_HISTORY_BATCH_IDS = 500;

/* Límite para la carga masiva de Stories/Bugs por Feature.
  Aunque la pantalla actual muestra 15 Features por página, se deja un máximo amplio para reutilizar el endpoint en futuras vistas sin
  permitir peticiones accidentalmente gigantes desde el navegador. */
const MAX_FEATURE_STORIES_BATCH_IDS = 500;

/* Azure DevOps acepta un máximo de 200 IDs en workitemsbatch. Esta constante se reutiliza tanto para Features como para Stories/Bugs.*/
const ADO_WORK_ITEMS_BATCH_SIZE = 200;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/* Ejecuta asyncFn sobre cada elemento, con un máximo de "limit" operaciones simultáneas.
  Conserva el orden de resultados, aunque en nuestros endpoints de historial escribiremos directamente en un objeto results por ID. */
async function mapWithConcurrency(items, limit, asyncFn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await asyncFn(
        items[currentIndex],
        currentIndex
      );
    }
  }
  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, () => worker())
  );
  return results;
}

/* Reintenta únicamente errores temporales de Azure DevOps o de red:
  - 429: throttling
  - 502, 503, 504: errores temporales de gateway/servicio
  - ECONNABORTED: timeout configurado por Axios
  - ECONNRESET: conexión cerrada inesperadamente
  - ETIMEDOUT: timeout de red/socket
  - EAI_AGAIN: fallo temporal de resolución DNS

  Si ADO incluye Retry-After, se respeta. Si no, usa backoff
  exponencial: 1 s, 2 s y 4 s.
*/
async function withAdoRetry(operation, maxRetries = 3) {
  const retryableStatusCodes = [429, 502, 503, 504];

  const retryableNetworkCodes = [
    'ECONNABORTED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EAI_AGAIN'
  ];

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      const status = error.response?.status;
      const errorCode = error.code || null;

      const retryable =
        retryableStatusCodes.includes(status) ||
        retryableNetworkCodes.includes(errorCode);

      if (!retryable || attempt === maxRetries) {
        throw error;
      }

      /*
        Retry-After solo aplica cuando Azure DevOps devolvió una
        respuesta HTTP, normalmente en escenarios de throttling 429.
        Los errores de red usan el backoff exponencial.
      */
      const retryAfterHeader =
        error.response?.headers?.['retry-after'];

      const retryAfterSeconds = Number(retryAfterHeader);

      const waitMs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1000
          : 1000 * (2 ** attempt);

      console.warn('Retrying Azure DevOps request', {
        status: status || null,
        errorCode,
        attempt: attempt + 1,
        maxRetries,
        waitMs
      });

      await delay(waitMs);
    }
  }

  throw lastError;
}

/*
  Centraliza la lógica repetida de extraer cambios de estado
  desde las revisiones de Azure DevOps.
*/
function getStateChangesFromRevisions(revisions) {
  const stateChanges = [];
  let previousState = null;

  (revisions || []).forEach(revision => {
    const currentState = revision.fields?.['System.State'];

    if (currentState && currentState !== previousState) {
      stateChanges.push({
        rev: revision.rev,
        state: currentState,
        changedDate: revision.fields?.['System.ChangedDate'],
        changedBy:
          revision.fields?.['System.ChangedBy']?.displayName ||
          revision.changedBy?.displayName ||
          'System'
      });

      previousState = currentState;
    }
  });

  return stateChanges;
}

/* El Cron se ejecuta diariamente. Se conservan 36 horas para que, incluso si el Cron diario llega más
  tarde de lo esperado o ADO falla durante una actualización, exista un shard previo válido al cual volver temporalmente.
  El Cron sigue intentando actualizar los datos cada día; este TTL sólo evita perder el fallback seguro entre ejecuciones. */
const OLD_FEATURES_CACHE_TTL_SECONDS = 36 * 60 * 60;
const RECENT_DAYS_THRESHOLD = 10;

/* Clave histórica heredada.
  Se conserva únicamente como fallback durante la migración a los shards incrementales v2. No debe usarse para nuevas escrituras.
  Podrá retirarse cuando los shards v2 hayan sido validados durante varios ciclos completos de Cron y TTL. */
const LEGACY_OLD_FEATURES_CACHE_KEY = 'oldFeaturesCache';

/* Prefijo de la nueva estructura incremental.
  Cada rango histórico se guarda de manera independiente, evitando que una sola respuesta parcial reemplace todo el historial. */
const OLD_FEATURES_CACHE_PREFIX = 'oldFeaturesCache:v2';

/* Features activos cuyo último cambio ocurrió hace más de 180 días, pero dentro de una ventana móvil máxima de aproximadamente dos años.
  No forman parte de OLD_FEATURES_DATE_RANGES porque agregan un criterio adicional: el Feature no puede estar en un estado terminal. */
const ACTIVE_OLD_FEATURES_MIN_AGE_DAYS = 180;
const ACTIVE_OLD_FEATURES_MAX_AGE_DAYS = 730;

/* La clave incluye explícitamente los límites del rango.
  Cambiar la clave evita reutilizar por error un caché creado anteriormente con la consulta desde el año 2000. La clave anterior ya no es leída por
  este código y expirará según el TTL con el que hubiera sido creada.*/
const ACTIVE_OLD_FEATURES_CACHE_KEY =
  `${OLD_FEATURES_CACHE_PREFIX}:active-changed-180-to-730-days`;

/* Calendario global de Iterations del proyecto. No depende de una configuración manual de Azure DevOps Teams.
  Se utiliza para identificar si el Iteration Path de cada Story/Bug corresponde a un Sprint vigente según startDate y finishDate.*/
const ITERATION_CALENDAR_CACHE_KEY =
  'iterationCalendar:v1';

const ITERATION_CALENDAR_CACHE_TTL_SECONDS =
  15 * 60;

/* Los rangos no se superponen:
  - Reciente en vivo: @today - 10 <= ChangedDate < @today + 1
  - Histórico cacheado: @today - 180 <= ChangedDate < @today - 10 */
const OLD_FEATURES_DATE_RANGES = [
  {
    cacheSuffix: 'changed-10-to-20-days',
    from: '@today - 20',
    to: `@today - ${RECENT_DAYS_THRESHOLD}`
  },
  {
    cacheSuffix: 'changed-20-to-30-days',
    from: '@today - 30',
    to: '@today - 20'
  },
  {
    cacheSuffix: 'changed-30-to-60-days',
    from: '@today - 60',
    to: '@today - 30'
  },
  {
    cacheSuffix: 'changed-60-to-90-days',
    from: '@today - 90',
    to: '@today - 60'
  },
  {
    cacheSuffix: 'changed-90-to-180-days',
    from: '@today - 180',
    to: '@today - 90'
  }
];

function getOldFeaturesRangeCacheKey(range) {
  return `${OLD_FEATURES_CACHE_PREFIX}:${range.cacheSuffix}`;
}

function getOldFeaturesRangeLabel(range) {
  return `${range.from} to ${range.to}`;
}

/* Escapa texto para usarlo como literal entre comillas simples en WIQL.
  Actualmente los estados provienen de un JSON local validado al iniciar, pero este escape evita generar una consulta inválida si en el futuro un
  estado incluye una comilla simple. */
function escapeWiqlString(value) {
  return String(value || '')
    .replace(/'/g, "''");
}

/* Construye condiciones separadas en vez de depender de NOT IN.
  Ejemplo:
    AND [System.State] <> 'Closed'
    AND [System.State] <> 'Done'
  BASE_FILTER ya excluye Removed. FEATURE_CLOSED_STATES representa la
  política configurada para estados terminales de Feature. */
function buildActiveFeatureStateFilter() {
  return FEATURE_CLOSED_STATES
    .map(
      state =>
        `[System.State] <> '${escapeWiqlString(state)}'`
    )
    .join(' AND ');
}

/* Un resultado de exactamente 200 IDs se trata como un rango potencialmente saturado. En vez de mostrar una advertencia y continuar con datos
posiblemente incompletos, el rango se divide automáticamente. */
const WIQL_SATURATION_LIMIT = 200;

/* Límite defensivo de la partición automática.  Si un rango de un minuto sigue devolviendo 200 Features, no es seguro
seguir reduciendo sin una estrategia adicional de paginación por ID.  En ese caso se lanza un error explícito para evitar ocultar datos faltantes. */
const WIQL_MINIMUM_RANGE_MS = 60 * 1000;

// ===== Cliente ADO reutilizable =====
/* La instancia se crea una sola vez cuando inicia el proceso. Todas las rutas siguen usando getAdoClient(), pero ahora reciben la misma instancia configurada. 
Esto evita crear objetos Axios repetidos y hace que el nombre "cliente reutilizable" sea consistente con el comportamiento real. */
const adoClient = axios.create({
  baseURL:
    `https://dev.azure.com/${process.env.ADO_ORG}/${process.env.ADO_PROJECT}/_apis`,
  timeout: 30000,
  headers: {
    Authorization: `Basic ${Buffer.from(
      `:${process.env.ADO_PAT}`
    ).toString('base64')}`,
    'Content-Type': 'application/json'
  }
});

function getAdoClient() {
  return adoClient;
}

// ===== Filtro base de Area Path  =====
const BASE_FILTER = 'AND [System.State] <> "Removed" AND ([System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition")';

// ===== Campos que se traen en el batch =====
// Los campos HTML se consultan solo para devolver una bandera boolean.
// Su contenido nunca se envía al navegador.
const FEATURE_FIELDS = [
  'System.Id',
  'System.Title',
  'System.State',
  'System.AreaPath',
  'System.IterationPath',
  'Microsoft.VSTS.Common.Priority',
  'Microsoft.VSTS.Scheduling.TargetDate',
  'Custom.PlannedMonth',
  'Custom.BEEstimate',
  'Custom.FEEstimates',
  'Custom.QASizing',
  'Custom.ReleaseFixVersion',
  'Custom.TechGoLiveRFV',
  'System.Tags',
  'System.AssignedTo',
  'Microsoft.VSTS.Common.AcceptanceCriteria',
  'System.Description',
  'Custom.PI_CustomerBenefit',
];

/* ===== Campos mínimos de Stories/Bugs para Delivery Health =====
  Solo se consultan para construir conteos y banderas. No se devuelven títulos, descripciones ni contenido sensible dentro del deliverySummary de /api/features.*/
const DELIVERY_WORK_ITEM_FIELDS = [
  'System.Id',
  'System.WorkItemType',
  'System.State',
  'System.AreaPath',
  'System.IterationPath',
  'Microsoft.VSTS.Scheduling.StoryPoints',
  'System.AssignedTo'
];

/* Campos requeridos para el detalle visual de Stories/Bugs.
  DELIVERY_WORK_ITEM_FIELDS se mantiene minimalista porque se usa al construir Delivery Health dentro de /api/features.
  STORY_WORK_ITEM_FIELDS incluye también el título porque esta respuesta se utiliza para mostrar cards, History y filas expandidas del Roadmap.*/
const STORY_WORK_ITEM_FIELDS = [
  'System.Id',
  'System.Title',
  'System.State',
  'System.WorkItemType',
  'System.AreaPath',
  'System.IterationPath',
  'System.AssignedTo',
  'System.Tags',
  'Custom.ReleaseFixVersion',
  'Microsoft.VSTS.Scheduling.StoryPoints'
];

// ===== Relaciones visuales Feature -> Story/Bug -> Bug =====
//
// No altera Delivery Health en Fase 1.
// Estos campos se usan exclusivamente para construir el grafo de
// relaciones que será consumido por el rediseño visual de Fase 2.

/* Azure DevOps puede devolver Related con nombres diferentes según el endpoint, configuración o representación del vínculo.
  Se soportan los valores conocidos para evitar perder relaciones mientras validamos cuáles devuelve específicamente la instancia ADO.*/
const RELATED_RELATION_TYPES = new Set([
  'System.LinkTypes.Related',
  'System.LinkTypes.Related-Forward',
  'System.LinkTypes.Related-Reverse'
]);

const HIERARCHY_FORWARD_RELATION =
  'System.LinkTypes.Hierarchy-Forward';

const MAX_FEATURE_RELATIONSHIP_BATCH_IDS = 500;

// ===== Estados de Delivery Health =====
//
// Las categorías deben ser mutuamente excluyentes:
//
// Included in delivery = Done + In progress + Pending
// Total work items = Included in delivery + Removed
//
// Los valores se cargan desde /delivery-health-rules.json.
// El código conserva la responsabilidad de clasificar y calcular;
// el JSON define la política de negocio vigente.

const REMOVED_WORK_STATES =
  deliveryHealthRules.workItemStates.removed;

const IN_PLANNING_WORK_STATES =
  deliveryHealthRules.workItemStates.inPlanning;

const IN_PROGRESS_WORK_STATES =
  deliveryHealthRules.workItemStates.inProgress;

const TO_RELEASE_WORK_STATES =
  deliveryHealthRules.workItemStates.toRelease;

const COMPLETED_WORK_STATES =
  deliveryHealthRules.workItemStates.completed;

/*
  Estados donde una Story o Bug debe contar con Story Points.
  Closed y Removed no deberían estar aquí mientras la política mantenga
  que trabajo terminado/removido no genera un riesgo de estimación.
*/
const ESTIMABLE_WORK_STATES =
  deliveryHealthRules.workItemStates.requiresEstimate;

// ===== Estados del Feature usados por Delivery Health =====

const FEATURE_DELIVERY_EXECUTION_STATES =
  deliveryHealthRules.featureStates.execution;

const FEATURE_CLOSED_STATES =
  deliveryHealthRules.featureStates.closed;

const FEATURE_NOT_STARTED_STATES =
  deliveryHealthRules.featureStates.notStarted;

const FEATURE_NO_ACTIVE_WORK_STATES =
  deliveryHealthRules.featureStates.noActiveWork;

/*
  Preserva la diferencia entre:
  - null: ADO no tiene Story Points informados;
  - 0: el work item tiene una estimación de cero.
  La política actual considera ambos casos como no estimados cuando el estado requiere estimación.
*/
function normalizeStoryPoints(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function workItemRequiresEstimate(state) {
  return ESTIMABLE_WORK_STATES.includes(String(state || '').trim());
}

function getDeliveryWorkItemCategory(state) {
  const normalizedState = String(state || '').trim();

  if (REMOVED_WORK_STATES.includes(normalizedState)) {
    return 'removed';
  }

  if (IN_PLANNING_WORK_STATES.includes(normalizedState)) {
    return 'inPlanning';
  }

  if (IN_PROGRESS_WORK_STATES.includes(normalizedState)) {
    return 'inProgress';
  }

  if (TO_RELEASE_WORK_STATES.includes(normalizedState)) {
    return 'toRelease';
  }

  if (COMPLETED_WORK_STATES.includes(normalizedState)) {
    return 'completed';
  }

  /*
    Política defensiva consistente con buildDeliverySummary():
    estados no configurados se tratan como In Planning.
  */
  return 'inPlanning';
}

function isWorkItemUnestimated(workItem) {
  const storyPoints = normalizeStoryPoints(workItem.storyPoints);

  return (
    workItemRequiresEstimate(workItem.state) &&
    (storyPoints === null || storyPoints <= 0)
  );
}

// ===== Utilidades para Delivery Health del Feature =====

function hasFeatureEstimate(feature) {
  const estimation = feature.estimation || {};

  return [
    estimation.be,
    estimation.fe,
    estimation.qa
  ].some(value => {
    return (
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ''
    );
  });
}

/*
  Convierte un valor de Azure DevOps a una fecha de negocio YYYY-MM-DD.

  Reglas:
  - Si ADO devuelve YYYY-MM-DD, ese valor ya representa una fecha de
    negocio y se conserva literalmente.
  - Si ADO devuelve un timestamp, se convierte a America/Chicago antes
    de extraer el día.
  - Nunca se usa toISOString() para obtener la fecha operativa porque
    toISOString() siempre convierte a UTC.
*/
function getDateKey(value) {
  if (!value) {
    return null;
  }

  const rawValue = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) {
    return rawValue;
  }

  const parsedDate = DateTime.fromISO(rawValue, {
    setZone: true
  });

  if (!parsedDate.isValid) {
    return null;
  }

  return parsedDate
    .setZone(DASHBOARD_TIME_ZONE)
    .toISODate();
}

/* Normaliza Area Paths e Iteration Paths para comparaciones seguras. Azure DevOps puede entregar rutas con o sin "\" inicial según el
  endpoint. El dashboard conserva la ruta original para mostrarla, pero usa esta versión normalizada al comparar. */
function normalizeAdoPath(value) {
  return String(value || '')
    .trim()
    .replace(/^\\+/, '')
    .replace(/\/+/g, '\\')
    .replace(/\\+/g, '\\')
    .toLowerCase();
}

/* Convierte un Area Path en un nombre corto visible. 
Ejemplo: Commercial Engineering\Digital\Acquisition\Cart and Checkout => Cart and Checkout */
function getAdoPathDisplayName(areaPath) {
  const parts = String(areaPath || '')
    .split('\\')
    .map(part => part.trim())
    .filter(Boolean);

  return parts.length > 0
    ? parts[parts.length - 1]
    : '';
}

/*
  Recorre el árbol de Iterations devuelto por Azure DevOps y crea
  un índice por Iteration Path.

  El endpoint puede devolver nodos anidados:
  Commercial Engineering
    └── 2026
        └── Q3
            └── 2026_S17_Aug12-Aug25
*/
function flattenIterationNodes(
  node,
  iterationsByPath = {}
) {
  if (!node || typeof node !== 'object') {
    return iterationsByPath;
  }

  const path = String(node.path || '').trim();
  const normalizedPath = normalizeAdoPath(path);

  if (normalizedPath) {
    const startDate = node.attributes?.startDate || null;
    const finishDate = node.attributes?.finishDate || null;

    iterationsByPath[normalizedPath] = {
      path,
      name: node.name || getAdoPathDisplayName(path),
      startDate,
      finishDate,
      startDateKey: getIterationDateKey(startDate),
      finishDateKey: getIterationDateKey(finishDate)
    };
  }

  (node.children || []).forEach(child => {
    flattenIterationNodes(child, iterationsByPath);
  });

  return iterationsByPath;
}

/* Obtiene el árbol global de Iterations del proyecto. No usa Azure DevOps Teams ni nombres manuales de equipos.
  El valor $depth=10 es suficiente para una jerarquía típica: root > year > quarter > sprint. */
async function getIterationCalendar(c) {
  const cachedCalendar = await redis.get(
    ITERATION_CALENDAR_CACHE_KEY
  );

  if (cachedCalendar) {
    return cachedCalendar;
  }

  try {
    const response = await withAdoRetry(() =>
      c.get(
        '/wit/classificationnodes/Iterations' +
        '?$depth=10&api-version=7.1'
      )
    );

    const iterationsByPath = flattenIterationNodes(
      response.data,
      {}
    );

    await redis.set(
      ITERATION_CALENDAR_CACHE_KEY,
      iterationsByPath,
      {
        ex: ITERATION_CALENDAR_CACHE_TTL_SECONDS
      }
    );

    return iterationsByPath;
  } catch (error) {
    console.error(
      'Unable to retrieve Azure DevOps Iteration calendar.',
      {
        adoStatus: error.response?.status || null,
        adoStatusText: error.response?.statusText || null,
        message: error.message
      }
    );

    /* La Fase 3 no debe impedir que el dashboard cargue. Si Iterations falla, la actividad de Sprint se marcará
    como unknown, pero Delivery Health seguirá funcionando. */
    return null;
  }
}

function getCurrentSprintForIterationPath(
  iterationPath,
  iterationsByPath
) {
  if (!iterationsByPath) {
    return null;
  }

  const normalizedPath = normalizeAdoPath(iterationPath);

  if (!normalizedPath) {
    return null;
  }

  const iteration = iterationsByPath[normalizedPath];

  if (!iteration) {
    return null;
  }

  /*
    Un Sprint sólo se considera vigente si tiene ambas fechas.
    Si Azure DevOps no tiene fechas configuradas, no asumimos
    incorrectamente que es actual.
  */
  if (
    !iteration.startDateKey ||
    !iteration.finishDateKey
  ) {
    return null;
  }

  const todayDateKey = getTodayDateKey();

  const isCurrent =
    iteration.startDateKey <= todayDateKey &&
    todayDateKey <= iteration.finishDateKey;

  return isCurrent
    ? iteration
    : null;
}

/* Crea un resumen de ejecución por Area Path de Stories/Bugs. No confunde: - responsible team: Area Path del Feature;
  - execution team: Area Path real de cada Story/Bug. */
function buildExecutionTeamsSummary(
  workItems,
  iterationsByPath
) {
  const teamsByAreaPath = new Map();

  workItems.forEach(item => {
    const areaPath = String(item.areaPath || '').trim();

    /* Si no hay Area Path, no hay equipo ejecutor identificable. El Story/Bug continúa contando para Delivery Health. */
    if (!areaPath) {
      return;
    }

    const state = String(item.state || '').trim();

    /* Removed no es trabajo de delivery activo y no debe aparecer como actividad ejecutora. */
    if (REMOVED_WORK_STATES.includes(state)) {
      return;
    }

    const key = normalizeAdoPath(areaPath);

    const currentSprint = getCurrentSprintForIterationPath(
      item.iterationPath,
      iterationsByPath
    );

    const existing = teamsByAreaPath.get(key) || {
      areaPath,
      name: getAdoPathDisplayName(areaPath),
      totalWorkItems: 0,
      inPlanningWorkItems: 0,
      inProgressWorkItems: 0,
      toReleaseWorkItems: 0,
      completedWorkItems: 0,
      currentSprintWorkItems: 0,
      currentSprints: {}
    };

    existing.totalWorkItems += 1;

    if (IN_PLANNING_WORK_STATES.includes(state)) {
      existing.inPlanningWorkItems += 1;
    } else if (IN_PROGRESS_WORK_STATES.includes(state)) {
      existing.inProgressWorkItems += 1;
    } else if (TO_RELEASE_WORK_STATES.includes(state)) {
      existing.toReleaseWorkItems += 1;
    } else if (COMPLETED_WORK_STATES.includes(state)) {
      existing.completedWorkItems += 1;
    } else {
      existing.inPlanningWorkItems += 1;
    }

    if (currentSprint) {
      existing.currentSprintWorkItems += 1;

      const sprintKey = normalizeAdoPath(
        currentSprint.path
      );

      const existingSprint =
        existing.currentSprints[sprintKey] || {
          iterationPath: currentSprint.path,
          name: currentSprint.name,
          startDate: currentSprint.startDateKey,
          finishDate: currentSprint.finishDateKey,
          workItems: 0
        };

      existingSprint.workItems += 1;

      existing.currentSprints[sprintKey] = existingSprint;
    }

    teamsByAreaPath.set(key, existing);
  });

  return [...teamsByAreaPath.values()]
    .map(team => ({
      ...team,
      currentSprints: Object.values(team.currentSprints)
    }))
    .sort((a, b) =>
      a.name.localeCompare(
        b.name,
        undefined,
        { sensitivity: 'base' }
      )
    );
}

/* Convierte el timestamp de Azure DevOps a fecha operativa del dashboard. Reutiliza getDateKey(), que ya respeta DASHBOARD_TIME_ZONE. */
function getIterationDateKey(value) {
  return getDateKey(value);
}

/* Fecha actual del negocio en America/Chicago. Ejemplo: - 2026-08-31 00:00 America/Chicago => una Feature con Target Date
    2026-08-30 pasa a considerarse overdue. */
function getTodayDateKey() {
  return DateTime
    .now()
    .setZone(DASHBOARD_TIME_ZONE)
    .toISODate();
}

/* Suma días calendario de negocio, no bloques fijos de 24 horas UTC. Esto es importante en cambios DST. Por ejemplo, America/Chicago puede
  tener días de 23 o 25 horas; "plus({ days: 1 })" sigue significando correctamente "el siguiente día calendario". */
function addDaysToDateKey(dateKey, days) {
  const date = DateTime.fromISO(dateKey, {
    zone: DASHBOARD_TIME_ZONE
  });

  if (!date.isValid) {
    throw new Error(
      `Unable to add days to invalid date key: "${dateKey}".`
    );
  }

  return date
    .plus({ days })
    .toISODate();
}

/* Target Date es inclusivo. La fecha se considera vencida solamente cuando el día de negocio actual es posterior al Target Date. Ejemplo:
  - Target Date: 2026-08-30
  - 2026-08-30 America/Chicago => vigente
  - 2026-08-31 America/Chicago => overdue */
function isPastTargetDate(targetDate) {
  const targetDateKey = getDateKey(targetDate);

  return Boolean(
    targetDateKey &&
    targetDateKey < getTodayDateKey()
  );
}

/*
  El umbral se obtiene desde delivery-health-rules.json:
    thresholds.targetDateNearDays

  El nombre no queda atado a "two weeks", porque el negocio puede
  cambiar el límite sin requerir modificaciones adicionales al código.
*/
function isTargetDateWithinConfiguredDays(targetDate) {
  const targetDateKey = getDateKey(targetDate);

  if (!targetDateKey) {
    return false;
  }

  const todayDateKey = getTodayDateKey();

  const targetDateNearDays =
    deliveryHealthRules.thresholds.targetDateNearDays;

  const thresholdDateKey = addDaysToDateKey(
    todayDateKey,
    targetDateNearDays
  );

  return (
    targetDateKey >= todayDateKey &&
    targetDateKey <= thresholdDateKey
  );
}

function isTargetDateInNextCalendarMonth(targetDate) {
  const targetDateKey = getDateKey(targetDate);

  if (!targetDateKey) {
    return false;
  }

  /*
    startOf('month') y endOf('month') se calculan en America/Chicago.
    Por tanto, "next calendar month" tiene exactamente el mismo
    significado para backend, Gantt y usuarios del dashboard.
  */
  const nextMonth = DateTime
    .now()
    .setZone(DASHBOARD_TIME_ZONE)
    .plus({ months: 1 });

  const nextMonthStartKey = nextMonth
    .startOf('month')
    .toISODate();

  const nextMonthEndKey = nextMonth
    .endOf('month')
    .toISODate();

  return (
    targetDateKey >= nextMonthStartKey &&
    targetDateKey <= nextMonthEndKey
  );
}

// ===== Determina si el Feature tiene un Parent jerárquico =====
// Solo devuelve true / false. No expone información del elemento padre.
function hasParentRelation(workItem) {
  return Array.isArray(workItem.relations) &&
    workItem.relations.some(
      relation => relation.rel === 'System.LinkTypes.Hierarchy-Reverse'
    );
}
const UNKNOWN = 'unknown';

// ===== Evalúa si un campo simple o HTML tiene contenido visible =====
// Devuelve true / false. No devuelve ni expone el contenido.
function hasMeaningfulValue(value) {
  if (value === null || value === undefined) {
    return false;
  }
  // Para campos HTML como Description y Acceptance Criteria,
  // evita considerar "<p></p>" o "&nbsp;" como contenido válido.
  if (typeof value === 'string') {
    const plainText = value
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .trim();
    return plainText.length > 0;
  }

  // Valores como 0 o false siguen siendo valores existentes.
  return true;
}

// ===== Resultado de validación para campos obtenidos desde ADO =====
// Si ADO no devolvió el work item o falló la consulta de campos,
// no se debe decir que el dato está ausente: es "unknown".
function fieldCheck(sourceStatus, value) {
  if (sourceStatus === UNKNOWN) {
    return UNKNOWN;
  }

  return hasMeaningfulValue(value);
}

// ===== Validación específica para Priority =====
// Priority debe existir y ser un número mayor a cero.
function priorityCheck(sourceStatus, value) {
  if (sourceStatus === UNKNOWN) {
    return UNKNOWN;
  }

  return Number(value) > 0;
}

// ===== Mapeo de un work item crudo -> objeto de salida =====
function mapFeature(i) {
  const fields = i.fields || {};

  // Compatibilidad: si un objeto no tiene _healthSource,
  // asumimos que sus datos llegaron correctamente.
  const fieldsSource = i._healthSource?.fields || 'ok';
  const relationsSource = i._healthSource?.relations || 'ok';

  const requiredFields = {
    acceptanceCriteria: fieldCheck(
      fieldsSource,
      fields['Microsoft.VSTS.Common.AcceptanceCriteria']
    ),

    businessImpact: fieldCheck(
      fieldsSource,
      fields['Custom.PI_CustomerBenefit']
    ),

    parent:
      relationsSource === UNKNOWN
        ? UNKNOWN
        : hasParentRelation(i),

    priority: priorityCheck(
      fieldsSource,
      fields['Microsoft.VSTS.Common.Priority']
    ),

    targetDate: fieldCheck(
      fieldsSource,
      fields['Microsoft.VSTS.Scheduling.TargetDate']
    ),

    description: fieldCheck(
      fieldsSource,
      fields['System.Description']
    )
  };

  const missingChecks = Object.entries(requiredFields)
    .filter(([, value]) => value === false)
    .map(([name]) => name);

  const unknownChecks = Object.entries(requiredFields)
    .filter(([, value]) => value === UNKNOWN)
    .map(([name]) => name);

  // Política de salud:
  // - Incomplete: se confirmó que al menos un requisito falta.
  // - Unknown: no falta nada confirmado, pero ADO no permitió validar algo.
  // - Healthy: todos los criterios fueron comprobados y cumplen.
  const health =
    missingChecks.length > 0
      ? 'Incomplete'
      : unknownChecks.length > 0
        ? 'Unknown'
        : 'Healthy';

  const mappedFeature = {
    // ===== Datos existentes para el dashboard: se conservan =====
    id: i.id,
    title: fields['System.Title'] || '',
    state: fields['System.State'] || '',
    areaPath: fields['System.AreaPath'] || '',
    /* Equipo responsable de la iniciativa: se deriva exclusivamente del Area Path del Feature. */
    responsibleTeam: {
      areaPath: fields['System.AreaPath'] || '',
      name: getAdoPathDisplayName(
        fields['System.AreaPath'] || ''
      )
    },
    iterationPath: fields['System.IterationPath'] || '',
    priority: fields['Microsoft.VSTS.Common.Priority'] || '',
    targetDate: fields['Microsoft.VSTS.Scheduling.TargetDate'] || '',
    plannedMonth: fields['Custom.PlannedMonth'] || '',
    releaseFixVersion: fields['Custom.ReleaseFixVersion'] || '',
    techGoLiveRFV: fields['Custom.TechGoLiveRFV'] || '',
    tags: fields['System.Tags'] || '',
    assignedTo: fields['System.AssignedTo']?.displayName || '',

    estimation: {
      be: fields['Custom.BEEstimate'] || '',
      fe: fields['Custom.FEEstimates'] || '',
      qa: fields['Custom.QASizing'] || ''
    },

    // ===== Resumen objetivo para Delivery Health =====
    // El backend entrega el mismo desglose que debe mostrar el frontend.
    // Las categorías Done, In progress y Pending son excluyentes.
    deliverySummary: i.deliverySummary || {
      source: 'unknown',
      hasWorkItems: null,
    
      totalWorkItems: null,
      includedWorkItems: null,
      removedWorkItems: null,
    
      inPlanningWorkItems: null,
      inProgressWorkItems: null,
      toReleaseWorkItems: null,
      completedWorkItems: null,
    
      completedForProgressWorkItems: null,
      openWorkItems: null,
      progressPercent: null,
    
      unestimatedWorkItems: null,
      discoveryWithoutSprintWorkItems: null,
      workItemsPendingDelivery: null,
    
      /*
        Aliases temporales para frontend antiguo.
      */
      doneWorkItems: null,
      pendingWorkItems: null,
      excludedWorkItems: null,
      activeWorkItems: null,
      pendingNonActiveWorkItems: null
    },

     // ===== Readiness: nuevo contrato de la API =====
    // Estos son los nombres que utilizará el frontend nuevo.
    readiness: health,
    readinessChecks: requiredFields,
    readinessMissingChecks: missingChecks,
    readinessUnknownChecks: unknownChecks,

    // ===== Compatibilidad temporal =====
    // Se mantienen los nombres antiguos hasta que el frontend y cualquier
    // dato cacheado hayan migrado completamente a readiness.
    requiredFields,
    health,
    missingChecks,
    unknownChecks,

    // Útil para diagnóstico técnico; no contiene datos sensibles.
    dataSources: {
      fields: fieldsSource,
      relations: relationsSource
    }
  };

  return {
    ...mappedFeature,
    deliveryHealth: buildDeliveryHealth(mappedFeature)
  };
}


// ===== Obtiene el ID de un work item desde la URL de una relación ADO =====
// Ejemplo de relation.url:
// https://dev.azure.com/{org}/{project}/_apis/wit/workItems/123456
function getWorkItemIdFromRelation(relation) {
  const match = String(relation?.url || '').match(
    /workItems\/(\d+)(?:\?|$)/i
  );

  return match ? Number(match[1]) : null;
}

// ===== Extrae IDs de hijos directos de un Feature =====
// Solo toma vínculos Feature -> Child. No incluye descendientes de segundo
// o tercer nivel, como Tasks bajo una User Story.
function getDirectChildWorkItemIds(feature) {
  if (!Array.isArray(feature.relations)) {
    return [];
  }

  return [
    ...new Set(
      feature.relations
        .filter(
          relation =>
            relation.rel === 'System.LinkTypes.Hierarchy-Forward'
        )
        .map(getWorkItemIdFromRelation)
        .filter(Number.isFinite)
    )
  ];
}

/* Convierte una relación devuelta por Azure DevOps a un formato independiente del endpoint y apto para el grafo visual.
  Sólo nos interesan:
  - Hierarchy-Forward => Child
  - Related / Related-Forward / Related-Reverse => Related*/
function getVisualRelationFromAdoRelation(relation) {
  const targetId = getWorkItemIdFromRelation(relation);
  if (!Number.isFinite(targetId)) {
    return null;
  }
  if (relation.rel === HIERARCHY_FORWARD_RELATION) {
    return {
      targetId,
      relationType: 'child',
      rawRelationType: relation.rel
    };
  }
  if (RELATED_RELATION_TYPES.has(relation.rel)) {
    return {
      targetId,
      relationType: 'related',
      rawRelationType: relation.rel
    };
  }
  return null;
}

/* Obtiene los vínculos directos relevantes de cualquier Work Item.
  Por ahora se excluyen:
  - Parent / Hierarchy-Reverse
  - Attachments
  - Hyperlinks
  - Duplicate
  - Test Case
  - Predecessor / Successor
  - otros tipos no definidos en el alcance funcional de Fase 1*/
function getVisualRelations(workItem) {
  if (!Array.isArray(workItem?.relations)) {
    return [];
  }
  const uniqueRelations = new Map();
  workItem.relations.forEach(relation => {
    const mappedRelation = getVisualRelationFromAdoRelation(relation);
    if (!mappedRelation) {
      return;
    }

    /* Puede ocurrir que ADO devuelva más de una referencia equivalente. Conservamos una sola relación por target + tipo. */
    const key =
      `${mappedRelation.targetId}:${mappedRelation.relationType}`;
    if (!uniqueRelations.has(key)) {
      uniqueRelations.set(key, mappedRelation);
    }
  });
  return [...uniqueRelations.values()];
}

function mapRelationshipGraphWorkItem(workItem) {
  const fields = workItem.fields || {};
  const assignedToField = fields['System.AssignedTo'];

  const assignedTo =
    typeof assignedToField === 'string'
      ? assignedToField
      : assignedToField?.displayName ||
        assignedToField?.uniqueName ||
        '';

  return {
  id: Number(workItem.id),
  title: fields['System.Title'] || '',
  workItemType: fields['System.WorkItemType'] || '',
  state: fields['System.State'] || '',
  areaPath: fields['System.AreaPath'] || '',
  iterationPath: fields['System.IterationPath'] || '',
  tags: fields['System.Tags'] || '',
  assignedTo,
  releaseFixVersion:
    fields['Custom.ReleaseFixVersion'] || '',
  storyPoints: normalizeStoryPoints(
    fields['Microsoft.VSTS.Scheduling.StoryPoints']
  )
};
}

// ===== Crea un resumen unificado de Stories/Bugs para Delivery Health =====
// Reglas:
// totalWorkItems = includedWorkItems + removedWorkItems
// includedWorkItems = doneWorkItems + inProgressWorkItems + pendingWorkItems
// openWorkItems = inProgressWorkItems + pendingWorkItems
// Removed no participa en delivery, progreso ni cobertura de estimación.
function buildDeliverySummary(workItems, source = 'ok', iterationsByPath = null) {
  const unknownSummary = {
    source: 'unknown',
    hasWorkItems: null,

    totalWorkItems: null,
    includedWorkItems: null,
    removedWorkItems: null,

    inPlanningWorkItems: null,
    inProgressWorkItems: null,
    toReleaseWorkItems: null,
    completedWorkItems: null,

    completedForProgressWorkItems: null,
    openWorkItems: null,
    progressPercent: null,

    unestimatedWorkItems: null,
    discoveryWithoutSprintWorkItems: null,
    workItemsPendingDelivery: null,
    
    /* Fase 3: executionTeams representa los equipos que realmente ejecutan Stories/Bugs, basado en System.AreaPath de cada hijo directo. */
    executionTeams: null,
    currentSprintWorkItems: null,

    /* Alias temporales para no romper consumidores existentes mientras actualizamos el frontend. */
    doneWorkItems: null,
    pendingWorkItems: null,
    excludedWorkItems: null,
    activeWorkItems: null,
    pendingNonActiveWorkItems: null
  };
  
  if (source !== 'ok') {
    return unknownSummary;
  }

  /* Delivery Health y progreso consideran exclusivamente hijos directos de tipo User Story o Bug. */
  const relevantWorkItems = workItems.filter(
    item =>
      item.workItemType === 'User Story' ||
      item.workItemType === 'Bug'
  );

  let removedWorkItems = 0;
  let inPlanningWorkItems = 0;
  let inProgressWorkItems = 0;
  let toReleaseWorkItems = 0;
  let completedWorkItems = 0;
  let unestimatedWorkItems = 0;
  let discoveryWithoutSprintWorkItems = 0;

  relevantWorkItems.forEach(item => {
    const state = String(item.state || '').trim();

    /* Removed queda fuera de:
      - denominador de progreso;
      - trabajo abierto;
      - reglas de estimación.  */
    if (REMOVED_WORK_STATES.includes(state)) {
      removedWorkItems += 1;
      return;
    }

    const hasIterationPath =
      typeof item.iterationPath === 'string' &&
      item.iterationPath.trim().length > 0;

    if (IN_PLANNING_WORK_STATES.includes(state)) {
      inPlanningWorkItems += 1;

      if (!hasIterationPath) {
        discoveryWithoutSprintWorkItems += 1;
      }
    } else if (IN_PROGRESS_WORK_STATES.includes(state)) {
      inProgressWorkItems += 1;
    } else if (TO_RELEASE_WORK_STATES.includes(state)) {
      toReleaseWorkItems += 1;
    } else if (COMPLETED_WORK_STATES.includes(state)) {
      completedWorkItems += 1;
    } else {
      /* Protección para estados nuevos o no configurados: se consideran In Planning hasta que se agreguen al JSON.
        Así no inflan progreso ni desaparecen del delivery. */
      inPlanningWorkItems += 1;

      if (!hasIterationPath) {
        discoveryWithoutSprintWorkItems += 1;
      }

      console.warn(
        'Unmapped User Story/Bug state treated as In Planning',
        {
          workItemId: item.id,
          workItemType: item.workItemType,
          state
        }
      );
    }

    if (isWorkItemUnestimated(item)) {
      unestimatedWorkItems += 1;
    }
  });

  const includedWorkItems =
    inPlanningWorkItems +
    inProgressWorkItems +
    toReleaseWorkItems +
    completedWorkItems;

  const totalWorkItems = relevantWorkItems.length;

  /*
    To Release cuenta como completado para porcentaje de progreso,
    aunque todavía sea trabajo abierto dentro del workflow.
  */
  const completedForProgressWorkItems =
    toReleaseWorkItems +
    completedWorkItems;

  /*
    Open significa que el work item no está cerrado ni removido.
  */
  const openWorkItems =
    inPlanningWorkItems +
    inProgressWorkItems;
    /*toReleaseWorkItems;*/

  const progressPercent =
    includedWorkItems > 0
      ? Math.round(
          (completedForProgressWorkItems / includedWorkItems) * 100
        )
      : 0;

  const executionTeams = buildExecutionTeamsSummary(
    relevantWorkItems,
    iterationsByPath
  );

  const currentSprintWorkItems = executionTeams.reduce(
    (total, team) => total + Number(team.currentSprintWorkItems || 0), 0
  );

  return {
    source: 'ok',

    hasWorkItems: includedWorkItems > 0,

    totalWorkItems,
    includedWorkItems,
    removedWorkItems,

    inPlanningWorkItems,
    inProgressWorkItems,
    toReleaseWorkItems,
    completedWorkItems,

    completedForProgressWorkItems,
    openWorkItems,
    progressPercent,

    unestimatedWorkItems,
    discoveryWithoutSprintWorkItems,

    /* Overdue sigue aplicando mientras exista trabajo no cerrado, incluyendo To Release. */
    workItemsPendingDelivery: openWorkItems > 0,
      executionTeams,
      currentSprintWorkItems,

    /* Aliases temporales:
      - done ahora significa "completo para progreso";
      - pending significa "In Planning + In Progress";
      - discovery conserva compatibilidad visual hasta editar HTML.  */
    doneWorkItems: completedForProgressWorkItems,
    pendingWorkItems:
      inPlanningWorkItems +
      inProgressWorkItems,

    excludedWorkItems: removedWorkItems,
    activeWorkItems: inProgressWorkItems,
    pendingNonActiveWorkItems: inPlanningWorkItems
  };
}

// ===== Fuente de verdad de Delivery Health =====
//
// El frontend debe mostrar esta información y no volver a calcular
// las reglas de negocio. Las alertas son acumulables: un Feature puede
// tener más de una condición que requiera seguimiento.
//
// Las condiciones técnicas se conservan aquí. Los estados, umbrales,
// labels, grupos, razones y acciones recomendadas viven en:
// /delivery-health-rules.json
function buildDeliveryHealth(feature) {
  const summary = feature.deliverySummary;
  const state = String(feature.state || '').trim();

  const createRuleAlert = (
    ruleKey,
    {
      reasonValues = {}
    } = {}
  ) => {
    const rule = getDeliveryHealthRule(ruleKey);

    return {
      key: ruleKey
        .replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`),
      label: rule.label,
      shortLabel: rule.shortLabel,
      group: rule.group,
      reason: rule.reasonTemplate
        ? formatDeliveryHealthReason(
            rule.reasonTemplate,
            reasonValues
          )
        : rule.reason,

      /*
        Este campo se devolverá desde ya, pero aún no se mostrará en
        la interfaz durante el punto 7.0. Se utilizará en el punto 7.1.
      */
      recommendedAction: rule.recommendedAction
    };
  };

  const unableToEvaluateRule = getDeliveryHealthRule(
    'unableToEvaluate'
  );

  const unknownResult = {
    primary: {
      key: 'unable-to-evaluate',
      label: unableToEvaluateRule.label,
      shortLabel: unableToEvaluateRule.shortLabel,
      group: unableToEvaluateRule.group,
      reason: unableToEvaluateRule.reason,
      recommendedAction: unableToEvaluateRule.recommendedAction
    },
    alerts: [
      {
        key: 'unable-to-evaluate',
        label: unableToEvaluateRule.label,
        group: unableToEvaluateRule.group,
        reason: unableToEvaluateRule.reason,
        recommendedAction: unableToEvaluateRule.recommendedAction
      }
    ]
  };

  if (!summary || summary.source !== 'ok') {
    return unknownResult;
  }
  
  const totalWorkItems = Number(summary.totalWorkItems || 0);
  const inPlanningWorkItems = Number( summary.inPlanningWorkItems || 0 );
  const inProgressWorkItems = Number( summary.inProgressWorkItems || 0 );
  const toReleaseWorkItems = Number( summary.toReleaseWorkItems || 0 );
  const openWorkItems = Number(summary.openWorkItems || 0);
  const unestimatedWorkItems = Number(summary.unestimatedWorkItems || 0 );
  const discoveryWithoutSprintWorkItems = Number( summary.discoveryWithoutSprintWorkItems || 0 );
  const isClosed = FEATURE_CLOSED_STATES.includes(state);
  const isExecutionState = FEATURE_DELIVERY_EXECUTION_STATES.includes(state);
  const isNotStartedState = FEATURE_NOT_STARTED_STATES.includes(state);

  /*
    Not started es informativo: no entra en Requires Action,
    Requires Attention ni Healthy. No representa una alerta.
  */
  const notStartedRule = getDeliveryHealthRule('notStarted');

  if (
    notStartedRule.enabled &&
    isNotStartedState &&
    !summary.hasWorkItems &&
    totalWorkItems === 0
  ) {
    const notStartedResult = createRuleAlert('notStarted');
  
    return {
      primary: notStartedResult,
      /* Not started se envía también como alerta para que la UI use exactamente el mismo patrón visual que el resto de condiciones. */
      alerts: [notStartedResult]
    };
  }

  const alerts = [];

  /*
    Prioridad 1: Target Date vencido con trabajo aún abierto.
  */
  const overdueRule = getDeliveryHealthRule('overdue');

  if (
    overdueRule.enabled &&
    isPastTargetDate(feature.targetDate) &&
    openWorkItems > 0
  ) {
    alerts.push(createRuleAlert('overdue'));
  }

  /*
    Prioridad 2: Target Date cercana con trabajo Discovery sin Sprint.
    El umbral de días viene de thresholds.targetDateNearDays.
  */
  const targetDateNearRule = getDeliveryHealthRule(
    'targetDateNearUnscheduledDiscovery'
  );

  if (
    targetDateNearRule.enabled &&
    isTargetDateWithinConfiguredDays(feature.targetDate) &&
    discoveryWithoutSprintWorkItems > 0
  ) {
    alerts.push(
      createRuleAlert(
        'targetDateNearUnscheduledDiscovery',
        {
          reasonValues: {
            count: discoveryWithoutSprintWorkItems
          }
        }
      )
    );
  }

  /*
    Prioridad 3: Fecha en el siguiente mes y sin Release Fix Version.
  */
  const targetNextMonthWithoutReleaseRule =
    getDeliveryHealthRule('targetNextMonthWithoutRelease');

  if (
    targetNextMonthWithoutReleaseRule.enabled &&
    isTargetDateInNextCalendarMonth(feature.targetDate) &&
    !String(feature.releaseFixVersion || '').trim()
  ) {
    alerts.push(
      createRuleAlert('targetNextMonthWithoutRelease')
    );
  }

  const closedWithOpenWorkRule = getDeliveryHealthRule(
    'closedWithOpenWork'
  );

  if (
    closedWithOpenWorkRule.enabled &&
    isClosed &&
    openWorkItems > 0
  ) {
    alerts.push(createRuleAlert('closedWithOpenWork'));
  }

  /*
    Los controles de estimación y ejecución se aplican únicamente
    desde los estados configurados en featureStates.execution.
  */
  const needsEstimateRule = getDeliveryHealthRule(
    'needsEstimate'
  );

  if (
    needsEstimateRule.enabled &&
    isExecutionState &&
    !hasFeatureEstimate(feature)
  ) {
    alerts.push(createRuleAlert('needsEstimate'));
  }

  const noStoriesRule = getDeliveryHealthRule('noStories');

  if (
    noStoriesRule.enabled &&
    isExecutionState &&
    (!summary.hasWorkItems || totalWorkItems === 0)
  ) {
    alerts.push(createRuleAlert('noStories'));
  }

  const noActiveWorkRule = getDeliveryHealthRule(
    'noActiveWork'
  );

  if (
    noActiveWorkRule.enabled &&
    FEATURE_NO_ACTIVE_WORK_STATES.includes(state) &&
    inPlanningWorkItems > 0 &&
    inProgressWorkItems === 0
  ) {
    alerts.push(createRuleAlert('noActiveWork'));
  }

  const unestimatedWorkRule = getDeliveryHealthRule(
    'unestimatedWork'
  );

  if (
    unestimatedWorkRule.enabled &&
    isExecutionState &&
    unestimatedWorkItems > 0
  ) {
    alerts.push(
      createRuleAlert(
        'unestimatedWork',
        {
          reasonValues: {
            count: unestimatedWorkItems
          }
        }
      )
    );
  }

  /*
    Si no hay alertas, el Feature está saludable. Esto incluye:
    - Closed sin trabajo abierto.
    - Estados anteriores a Planned.
    - Features en ejecución sin riesgos detectados.
  */
  if (alerts.length === 0) {
    const healthyResult = createRuleAlert('healthy');
  
    return {
      primary: healthyResult,
      alerts: [healthyResult]
    };
  }

  const primaryAlert = alerts[0];

  return {
    primary: {
      ...primaryAlert
    },
    alerts
  };
}

// ===== Consulta campos de Stories/Bugs relacionados en lotes de 200 =====
// Evita el patrón de una consulta por Feature.
async function fetchDeliveryWorkItemsBatch(c, ids) {
  const batchSize = 200;
  const workItemsById = new Map();
  const unavailableIds = new Set();

  for (let i = 0; i < ids.length; i += batchSize) {
    const currentIds = ids.slice(i, i + batchSize);

    try {
      const response = await withAdoRetry(() =>
        c.post('/wit/workitemsbatch?api-version=7.0', {
          ids: currentIds,
          fields: DELIVERY_WORK_ITEM_FIELDS,
          errorPolicy: 'Omit'
        })
      );

      const returnedWorkItems = response.data.value || [];
      const returnedIds = new Set(
        returnedWorkItems.map(workItem => workItem.id)
      );

      returnedWorkItems.forEach(workItem => {
        const fields = workItem.fields || {};

        workItemsById.set(workItem.id, {
          id: workItem.id,
          workItemType: fields['System.WorkItemType'] || '',
          state: fields['System.State'] || '',
          areaPath: fields['System.AreaPath'] || '',
          iterationPath: fields['System.IterationPath'] || '',
          storyPoints: normalizeStoryPoints(
            fields['Microsoft.VSTS.Scheduling.StoryPoints']
          ),
          assignedTo:
            typeof fields['System.AssignedTo'] === 'string'
              ? fields['System.AssignedTo']
              : fields['System.AssignedTo']?.displayName ||
                fields['System.AssignedTo']?.uniqueName ||
                ''
        });
      });

      // Si ADO omitió un ID solicitado, no se debe interpretar como
      // "sin Stories"; el resultado del Feature será unknown.
      currentIds.forEach(id => {
        if (!returnedIds.has(id)) {
          unavailableIds.add(id);
        }
      });
    } catch (error) {
      console.error('ERROR fetching Delivery Health work items batch from ADO', {
        batchStart: i,
        batchSize: currentIds.length,
        adoStatus: error.response?.status || null,
        adoStatusText: error.response?.statusText || null,
        adoResponse: error.response?.data || null,
        message: error.message
      });

      currentIds.forEach(id => unavailableIds.add(id));
    }
  }

  return {
    workItemsById,
    unavailableIds
  };
}

// ===== Adjunta deliverySummary a Features ya obtenidos en un batch =====
// Reutiliza las relaciones directas que fetchFeatureDetailsBatch ya pidió.
// Solo añade una consulta masiva de campos mínimos para los hijos únicos.
async function enrichFeaturesWithDeliverySummary(c, features, iterationsByPath = null) {
  const childIdsByFeature = new Map();
  const allChildIds = new Set();

  features.forEach(feature => {
    const relationsSource = feature._healthSource?.relations || 'unknown';

    if (relationsSource !== 'ok') {
      childIdsByFeature.set(feature.id, null);
      return;
    }

    const childIds = getDirectChildWorkItemIds(feature);

    childIdsByFeature.set(feature.id, childIds);

    childIds.forEach(id => allChildIds.add(id));
  });

  const {
    workItemsById,
    unavailableIds
  } = allChildIds.size > 0
    ? await fetchDeliveryWorkItemsBatch(c, [...allChildIds])
    : {
        workItemsById: new Map(),
        unavailableIds: new Set()
      };

  return features.map(feature => {
    const childIds = childIdsByFeature.get(feature.id);

    // La consulta de relaciones del Feature falló u omitió el Feature.
    if (childIds === null) {
      return {
        ...feature,
        deliverySummary: buildDeliverySummary( [], 'unknown', iterationsByPath )
      };
    }

    // Si ADO omitió uno o varios elementos hijos, no es seguro concluir
    // que el Feature no tiene trabajo pendiente.
    const hasUnavailableChild = childIds.some(
      childId => unavailableIds.has(childId)
    );

    if (hasUnavailableChild) {
      return {
        ...feature,
        deliverySummary: buildDeliverySummary([], 'unknown', iterationsByPath )
      };
    }

    const deliveryWorkItems = childIds
      .map(childId => workItemsById.get(childId))
      .filter(Boolean);

    return {
      ...feature,
      deliverySummary: buildDeliverySummary(deliveryWorkItems, 'ok', iterationsByPath)
    };
  });
}

// ===== Mapea un Story/Bug para el detalle visual del dashboard =====
function mapFeatureStoryWorkItem(workItem) {
  const fields = workItem.fields || {};
  const assignedToField = fields['System.AssignedTo'];
  const state = fields['System.State'] || '';
  const storyPoints = normalizeStoryPoints(
    fields['Microsoft.VSTS.Scheduling.StoryPoints']
  );

  /* Normaliza Assigned To porque ADO puede devolver:
    - un objeto IdentityRef con displayName;
    - un texto;
    - uniqueName como fallback. */
  const assignedTo =
    typeof assignedToField === 'string'
      ? assignedToField
      : assignedToField?.displayName ||
        assignedToField?.uniqueName ||
        '';

  const deliveryWorkItem = {
    id: workItem.id,
    state,
    storyPoints
  };

  return {
    id: workItem.id,
    title: fields['System.Title'] || '',
    storyPoints,
    state,
    workItemType: fields['System.WorkItemType'] || '',
    areaPath: fields['System.AreaPath'] || '',
    iterationPath: fields['System.IterationPath'] || '',
    releaseFixVersion: fields['Custom.ReleaseFixVersion'] || '',
    tags: fields['System.Tags'] || '',
    assignedTo,
  
    deliveryCategory: getDeliveryWorkItemCategory(state),
  
    requiresEstimate: workItemRequiresEstimate(state),
    isUnestimated: isWorkItemUnestimated(deliveryWorkItem)
  };
}

/*
  Obtiene Features con relaciones directas en batches de máximo 200.

  Devuelve:
  - featuresById: Feature crudo por ID;
  - unavailableFeatureIds: Features que ADO no devolvió o cuya petición falló.

  Es importante diferenciar "Feature sin hijos" de "Feature no disponible":
  - Feature recibido con relations: [] => no tiene Stories/Bugs.
  - Feature no recibido / petición fallida => unavailable.
*/
async function fetchFeaturesWithRelationsBatch(c, featureIds) {
  const featuresById = new Map();
  const unavailableFeatureIds = new Set();

  for (
    let index = 0;
    index < featureIds.length;
    index += ADO_WORK_ITEMS_BATCH_SIZE
  ) {
    const currentIds = featureIds.slice(
      index,
      index + ADO_WORK_ITEMS_BATCH_SIZE
    );

    try {
      const response = await withAdoRetry(() =>
        c.post('/wit/workitemsbatch?api-version=7.0', {
          ids: currentIds,
          $expand: 'Relations',
          errorPolicy: 'Omit'
        })
      );

      const returnedFeatures = response.data?.value || [];
      const returnedIds = new Set(
        returnedFeatures.map(feature => Number(feature.id))
      );

      returnedFeatures.forEach(feature => {
        featuresById.set(Number(feature.id), feature);
      });

      /*
        Si ADO omitió un Feature solicitado, no se debe responder []
        porque el frontend interpretaría incorrectamente que no tiene
        Stories/Bugs asociados.
      */
      currentIds.forEach(featureId => {
        if (!returnedIds.has(featureId)) {
          unavailableFeatureIds.add(featureId);
        }
      });
    } catch (error) {
      console.error(
        'ERROR fetching Feature relations batch for Stories/Bugs from ADO',
        {
          batchStart: index,
          batchSize: currentIds.length,
          adoStatus: error.response?.status || null,
          adoStatusText: error.response?.statusText || null,
          adoResponse: error.response?.data || null,
          message: error.message
        }
      );

      currentIds.forEach(featureId => {
        unavailableFeatureIds.add(featureId);
      });
    }
  }

  return {
    featuresById,
    unavailableFeatureIds
  };
}

/*
  Obtiene los detalles visuales de los hijos únicos de todos los Features.

  Si una solicitud batch falla, los IDs hijos de ese batch se agregan a
  unavailableWorkItemIds. Después, cada Feature afectado se marcará como
  unavailable sin bloquear los resultados correctos de otros Features.
*/
async function fetchFeatureStoryWorkItemsBatch(c, workItemIds) {
  const workItemsById = new Map();
  const unavailableWorkItemIds = new Set();

  for (
    let index = 0;
    index < workItemIds.length;
    index += ADO_WORK_ITEMS_BATCH_SIZE
  ) {
    const currentIds = workItemIds.slice(
      index,
      index + ADO_WORK_ITEMS_BATCH_SIZE
    );

    try {
      const response = await withAdoRetry(() =>
        c.post('/wit/workitemsbatch?api-version=7.0', {
          ids: currentIds,
          fields: STORY_WORK_ITEM_FIELDS,
          errorPolicy: 'Omit'
        })
      );

      const returnedWorkItems = response.data?.value || [];
      const returnedIds = new Set(
        returnedWorkItems.map(workItem => Number(workItem.id))
      );

      returnedWorkItems.forEach(workItem => {
        workItemsById.set(
          Number(workItem.id),
          mapFeatureStoryWorkItem(workItem)
        );
      });

      /*
        Un ID omitido por ADO es distinto de un hijo que no sea Bug o
        User Story. El primero indica una carga incompleta; el segundo
        simplemente no debe aparecer en el dashboard.
      */
      currentIds.forEach(workItemId => {
        if (!returnedIds.has(workItemId)) {
          unavailableWorkItemIds.add(workItemId);
        }
      });
    } catch (error) {
      console.error(
        'ERROR fetching Stories/Bugs work items batch from ADO',
        {
          batchStart: index,
          batchSize: currentIds.length,
          adoStatus: error.response?.status || null,
          adoStatusText: error.response?.statusText || null,
          adoResponse: error.response?.data || null,
          message: error.message
        }
      );

      currentIds.forEach(workItemId => {
        unavailableWorkItemIds.add(workItemId);
      });
    }
  }

  return {
    workItemsById,
    unavailableWorkItemIds
  };
}

/* Recupera Work Items con fields + relations en batches de máximo 200.
  Es reutilizable para:
  - User Stories / Bugs vinculados a Features;
  - Bugs vinculados desde User Stories;
  - futuras extensiones del grafo.
  Si ADO omite algún ID solicitado, se agrega a unavailableWorkItemIds.
  Esto evita presentar un árbol incompleto como si estuviera completo. */
async function fetchRelationshipGraphWorkItemsBatch(c, workItemIds) {
  const workItemsById = new Map();
  const unavailableWorkItemIds = new Set();

  for (
    let index = 0;
    index < workItemIds.length;
    index += ADO_WORK_ITEMS_BATCH_SIZE
  ) {
    const currentIds = workItemIds.slice(
      index,
      index + ADO_WORK_ITEMS_BATCH_SIZE
    );

    try {
     const response = await withAdoRetry(() =>
       c.post('/wit/workitemsbatch?api-version=7.0', {
         ids: currentIds,
         $expand: 'All',
         errorPolicy: 'Omit'
       })
    );

      const returnedWorkItems = response.data?.value || [];

      const returnedIds = new Set(
        returnedWorkItems.map(workItem => Number(workItem.id))
      );

      returnedWorkItems.forEach(workItem => {
        workItemsById.set(Number(workItem.id), workItem);
      });

      currentIds.forEach(workItemId => {
        if (!returnedIds.has(workItemId)) {
          unavailableWorkItemIds.add(workItemId);
        }
      });
    } catch (error) {
      console.error(
        'ERROR fetching relationship graph work items batch from ADO',
        {
          batchStart: index,
          batchSize: currentIds.length,
          adoStatus: error.response?.status || null,
          adoStatusText: error.response?.statusText || null,
          adoResponse: error.response?.data || null,
          message: error.message
        }
      );

      currentIds.forEach(workItemId => {
        unavailableWorkItemIds.add(workItemId);
      });
    }
  }

  return {
    workItemsById,
    unavailableWorkItemIds
  };
}

function createEmptyRelationshipGraph(featureId) {
  return {
    source: 'ok',

    /*
      Colecciones preparadas para la UI.

      No reemplazan nodes/edges; son una proyección funcional del
      grafo para que el frontend no tenga que interpretar relaciones
      crudas ni consultar datos adicionales de ADO.
    */
    directFeatureChildBugs: [],
    directFeatureRelatedBugs: [],
    childStoryRelatedBugs: [],
    directFeatureRelatedStories: [],

    summary: {
      directChildStories: 0,
      directChildBugs: 0,
      relatedStories: 0,
      relatedBugs: 0,
      nestedChildBugs: 0,
      nestedRelatedBugs: 0,
      totalUniqueLinkedItems: 0
    },

    nodes: [
      {
        id: Number(featureId),
        title: '',
        workItemType: 'Feature',
        state: '',
        areaPath: '',
        iterationPath: '',
        tags: '',
        assignedTo: '',
        storyPoints: null
      }
    ],

    edges: []
  };
}

function addGraphEdge(edgesByKey, edge) {
  const key =
    `${edge.sourceId}:${edge.targetId}:${edge.relationType}`;

  if (!edgesByKey.has(key)) {
    edgesByKey.set(key, edge);
  }
}

/*
  Construye un resumen técnico/funcional del grafo.

  No reutiliza deliverySummary porque:
  - deliverySummary sólo considera hijos directos;
  - esta estructura incluye Related y Bugs de segundo nivel;
  - Fase 1 no debe alterar las reglas actuales de Delivery Health.
*/
function buildRelationshipGraphSummary(graph) {
  const summary = {
    directChildStories: 0,
    directChildBugs: 0,
    relatedStories: 0,
    relatedBugs: 0,
    nestedChildBugs: 0,
    nestedRelatedBugs: 0,
    totalUniqueLinkedItems: 0
  };

  const nodeById = new Map(
    graph.nodes.map(node => [Number(node.id), node])
  );

  graph.edges.forEach(edge => {
    const target = nodeById.get(Number(edge.targetId));

    if (!target) {
      return;
    }

    /*
      Nivel 1: Feature -> User Story / Bug
    */
    if (edge.level === 1) {
      if (
        edge.relationType === 'child' &&
        target.workItemType === 'User Story'
      ) {
        summary.directChildStories += 1;
      }

      if (
        edge.relationType === 'child' &&
        target.workItemType === 'Bug'
      ) {
        summary.directChildBugs += 1;
      }

      if (
        edge.relationType === 'related' &&
        target.workItemType === 'User Story'
      ) {
        summary.relatedStories += 1;
      }

      if (
        edge.relationType === 'related' &&
        target.workItemType === 'Bug'
      ) {
        summary.relatedBugs += 1;
      }
    }

    /*
      Nivel 2: User Story -> Bug
    */
    if (
      edge.level === 2 &&
      target.workItemType === 'Bug'
    ) {
      if (edge.relationType === 'child') {
        summary.nestedChildBugs += 1;
      }

      if (edge.relationType === 'related') {
        summary.nestedRelatedBugs += 1;
      }
    }
  });

  summary.totalUniqueLinkedItems = graph.nodes.filter(
    node => node.workItemType !== 'Feature'
  ).length;

  return summary;
}

/* Convierte el grafo técnico (nodes + edges) a colecciones que la UI puede consumir directamente.
  Importante:
  - Los hijos directos se mantienen separados.
  - Los Bugs Related a una Story hija se consolidan por Bug ID.
  - Un Bug puede conservar múltiples Stories de origen.
  - Estas relaciones son informativas; no alteran Delivery Health. */
function buildRelationshipGraphUiCollections(graph) {
  const nodeById = new Map(
    (graph.nodes || []).map(node => [Number(node.id), node])
  );

  const directFeatureChildBugsById = new Map();
  const directFeatureRelatedBugsById = new Map();
  const directFeatureRelatedStoriesById = new Map();
  const childStoryRelatedBugsById = new Map();

  /* Primero identificamos cuáles Stories son realmente hijas directas del Feature. Sólo estas Stories deben participar en: Feature -> Child Story -> Related Bug */
  const directChildStoryIds = new Set(
    (graph.edges || [])
      .filter(edge => {
        if (
          edge.level !== 1 ||
          edge.relationType !== 'child'
        ) {
          return false;
        }

        const target = nodeById.get(Number(edge.targetId));

        return target?.workItemType === 'User Story';
      })
      .map(edge => Number(edge.targetId))
  );

  (graph.edges || []).forEach(edge => {
    const target = nodeById.get(Number(edge.targetId));

    if (!target) {
      return;
    }

    /* Nivel 1: Feature -> Child / Related -> Story or Bug */
    if (edge.level === 1) {
      if (
        edge.relationType === 'child' &&
        target.workItemType === 'Bug'
      ) {
        directFeatureChildBugsById.set(
          Number(target.id),
          target
        );
      }

      if (
        edge.relationType === 'related' &&
        target.workItemType === 'Bug'
      ) {
        directFeatureRelatedBugsById.set(
          Number(target.id),
          target
        );
      }

      if (
        edge.relationType === 'related' &&
        target.workItemType === 'User Story'
      ) {
        directFeatureRelatedStoriesById.set(
          Number(target.id),
          target
        );
      }

      return;
    }

    /* Nivel 2: Story hija directa -> Related -> Bug
      Sólo se incluyen relaciones Related. Un Bug Child de una Story no entra como Linked Bug informativo. */
    if (
      edge.level !== 2 ||
      edge.relationType !== 'related' ||
      target.workItemType !== 'Bug'
    ) {
      return;
    }

    const sourceStoryId = Number(edge.sourceId);

    /* Protección adicional: aunque el grafo tuviera otro tipo de Story en nivel 2, sólo aceptamos las Stories hijas directas del Feature. */
    if (!directChildStoryIds.has(sourceStoryId)) {
      return;
    }

    const bugId = Number(target.id);

    const existingBug = childStoryRelatedBugsById.get(bugId);

    childStoryRelatedBugsById.set(bugId, {
      ...target,

      /* Conserva todos los vínculos Story -> Bug.
        Ejemplo:
        Bug #1207509:
          relatedFromStoryIds: [1209243, 1215566]  */
      relatedFromStoryIds: [
        ...new Set([
          ...(existingBug?.relatedFromStoryIds || []),
          sourceStoryId
        ])
      ]
    });
  });

  return {
    directFeatureChildBugs: [
      ...directFeatureChildBugsById.values()
    ],

    directFeatureRelatedBugs: [
      ...directFeatureRelatedBugsById.values()
    ],

    childStoryRelatedBugs: [
      ...childStoryRelatedBugsById.values()
    ],

    directFeatureRelatedStories: [
      ...directFeatureRelatedStoriesById.values()
    ]
  };
}

/* Carga el grafo de relaciones para varios Features sin ejecutar una petición ADO por Feature.
  Profundidad máxima:
  Feature
    ├── Child / Related -> User Story o Bug
    └── User Story
          └── Child / Related -> Bug
  No se recorren Bugs -> Bugs ni User Story -> User Story. */
async function fetchRelationshipGraphsForFeaturesBatch(c, featureIds) {
  const results = {};
  const unavailableFeatureIds = new Set();

  featureIds.forEach(featureId => {
    results[featureId] = createEmptyRelationshipGraph(featureId);
  });

  /* Paso 1: Reutilizamos la función existente que obtiene relaciones de Features. */
  const {
    featuresById,
    unavailableFeatureIds: unavailableRootFeatureIds
  } = await fetchFeaturesWithRelationsBatch(c, featureIds);
     
  unavailableRootFeatureIds.forEach(featureId => {
    unavailableFeatureIds.add(featureId);
  });

  /* Paso 2: Extraer todos los targets de primer nivel: Feature -> Child / Related -> Story o Bug. */
  const firstLevelRelationsByFeature = new Map();
  const firstLevelIds = new Set();

  featureIds.forEach(featureId => {
    if (unavailableFeatureIds.has(featureId)) {
      return;
    }

    const feature = featuresById.get(featureId);

    if (!feature) {
      unavailableFeatureIds.add(featureId);
      return;
    }

    const relations = getVisualRelations(feature);

    firstLevelRelationsByFeature.set(featureId, relations);

    relations.forEach(relation => {
      firstLevelIds.add(relation.targetId);
    });
  });

  /* Paso 3: Obtener detalles + relaciones de los targets del Feature. */
  const {
    workItemsById: firstLevelWorkItemsById,
    unavailableWorkItemIds: unavailableFirstLevelIds
  } = firstLevelIds.size > 0
    ? await fetchRelationshipGraphWorkItemsBatch(
        c,
        [...firstLevelIds]
      )
    : {
        workItemsById: new Map(),
        unavailableWorkItemIds: new Set()
      };
  
  /* Paso 4: Identificar Bugs de segundo nivel: User Story -> Child / Related -> Bug. */
  const secondLevelRelationsByFeature = new Map();
  const secondLevelIds = new Set();

  featureIds.forEach(featureId => {
    if (unavailableFeatureIds.has(featureId)) {
      return;
    }

    const firstLevelRelations =
      firstLevelRelationsByFeature.get(featureId) || [];

    const featureHasUnavailableFirstLevelTarget =
      firstLevelRelations.some(relation =>
        unavailableFirstLevelIds.has(relation.targetId)
      );

    if (featureHasUnavailableFirstLevelTarget) {
      unavailableFeatureIds.add(featureId);
      return;
    }

    const nestedRelations = [];

    firstLevelRelations.forEach(featureRelation => {
      const firstLevelWorkItem = firstLevelWorkItemsById.get(
        featureRelation.targetId
      );

      /* Sólo recorremos relaciones desde User Stories hijas directas.      
        No recorremos:
        - Stories relacionadas directamente al Feature;
        - Bugs directos del Feature;
        - Tasks;
        - otros tipos de Work Item.  */
      if (
        featureRelation.relationType !== 'child' ||
        firstLevelWorkItem?.fields?.['System.WorkItemType'] !==
          'User Story'
      ) {
        return;
      }

      getVisualRelations(firstLevelWorkItem).forEach(
        storyRelation => {
          nestedRelations.push({
            sourceId: Number(firstLevelWorkItem.id),
            targetId: storyRelation.targetId,
            relationType: storyRelation.relationType,
            rawRelationType: storyRelation.rawRelationType
          });

          secondLevelIds.add(storyRelation.targetId);
        }
      );
    });

    secondLevelRelationsByFeature.set(featureId, nestedRelations);
  });

  /* Paso 5: Obtener los targets de segundo nivel. Después se filtrarán para conservar exclusivamente Bugs. */
  const {
    workItemsById: secondLevelWorkItemsById,
    unavailableWorkItemIds: unavailableSecondLevelIds
  } = secondLevelIds.size > 0
    ? await fetchRelationshipGraphWorkItemsBatch(
        c,
        [...secondLevelIds]
      )
    : {
        workItemsById: new Map(),
        unavailableWorkItemIds: new Set()
      };

  /* Paso 6: Construir nodes + edges por Feature. */
  featureIds.forEach(featureId => {
    if (unavailableFeatureIds.has(featureId)) {
      return;
    }

    const firstLevelRelations =
      firstLevelRelationsByFeature.get(featureId) || [];

    const nestedRelations =
      secondLevelRelationsByFeature.get(featureId) || [];

    /* Si una relación de segundo nivel no pudo recuperarse, el resultado completo del Feature queda como unavailable.
      Esto es preferible a mostrar un árbol aparentemente completo. */
    const hasUnavailableSecondLevelTarget =
      nestedRelations.some(relation =>
        unavailableSecondLevelIds.has(relation.targetId)
      );

    if (hasUnavailableSecondLevelTarget) {
      unavailableFeatureIds.add(featureId);
      return;
    }

    const graph = createEmptyRelationshipGraph(featureId);
    const nodesById = new Map(
      graph.nodes.map(node => [Number(node.id), node])
    );
    const edgesByKey = new Map();

    /* Nivel 1: Feature -> User Story / Bug. */
    firstLevelRelations.forEach(relation => {
      const workItem = firstLevelWorkItemsById.get(relation.targetId);

      if (!workItem) {
        return;
      }

      const node = mapRelationshipGraphWorkItem(workItem);

      /*  En el primer nivel sólo incluimos User Story y Bug. */
      if (
        node.workItemType !== 'User Story' &&
        node.workItemType !== 'Bug'
      ) {
        return;
      }

      nodesById.set(node.id, node);

      addGraphEdge(edgesByKey, {
        sourceId: Number(featureId),
        targetId: node.id,
        relationType: relation.relationType,
        rawRelationType: relation.rawRelationType,
        level: 1
      });
    });

    /* Nivel 2: User Story -> Bug. */
    nestedRelations.forEach(relation => {
      const targetWorkItem = secondLevelWorkItemsById.get(
        relation.targetId
      );

      if (!targetWorkItem) {
        return;
      }

      const targetNode = mapRelationshipGraphWorkItem(
        targetWorkItem
      );

      /* El alcance definido para Fase 1 es exclusivamente: User Story -> Bug.
        Por lo tanto se ignoran:
        - User Story -> User Story
        - User Story -> Task
        - User Story -> Feature
        - User Story -> Test Case
        - cualquier otro Work Item Type */
      if (targetNode.workItemType !== 'Bug') {
        return;
      }

      nodesById.set(targetNode.id, targetNode);

      addGraphEdge(edgesByKey, {
        sourceId: relation.sourceId,
        targetId: targetNode.id,
        relationType: relation.relationType,
        rawRelationType: relation.rawRelationType,
        level: 2
      });
    });

    graph.nodes = [...nodesById.values()];
    graph.edges = [...edgesByKey.values()];
    graph.summary = buildRelationshipGraphSummary(graph);

    /*
      Mantiene nodes y edges para diagnóstico o para una futura vista
      de grafo, y agrega colecciones que el frontend puede usar directamente.
    */
    Object.assign(
      graph,
      buildRelationshipGraphUiCollections(graph)
    );

    results[featureId] = graph;
  });

  /* Este bloque debe estar FUERA del featureIds.forEach del Paso 6. Marca solamente los Features cuya información no se pudo cargar completamente desde Azure DevOps. */
  unavailableFeatureIds.forEach(featureId => {
    results[featureId] = {
      ...createEmptyRelationshipGraph(featureId),
      source: 'unknown'
    };
  });

  return {
    results,
    unavailableFeatureIds: [...unavailableFeatureIds]
  };
}

/* Carga Stories/Bugs de varios Features en una única operación lógica.

  Flujo:
  1. Obtiene relaciones directas de todos los Features solicitados.
  2. Extrae IDs hijos únicos.
  3. Obtiene campos de todos los hijos en batches de máximo 200.
  4. Reconstruye el resultado agrupado por Feature.

  El resultado no considera como error que un Feature tenga cero hijos.
  En cambio, sí declara unavailable si ADO no permitió recuperar los
  datos necesarios para determinar el resultado real. */
async function fetchStoriesForFeaturesBatch(c, featureIds) {
  const results = {};
  const unavailableFeatureIds = new Set();

  /*
    Inicializamos siempre las claves solicitadas para que el contrato sea
    predecible. Si no hay problemas técnicos, [] significa realmente
    "no tiene Stories/Bugs directos".
  */
  featureIds.forEach(featureId => {
    results[featureId] = [];
  });

  const {
    featuresById,
    unavailableFeatureIds: unavailableRelationsFeatureIds
  } = await fetchFeaturesWithRelationsBatch(c, featureIds);

  unavailableRelationsFeatureIds.forEach(featureId => {
    unavailableFeatureIds.add(featureId);
  });

  const childIdsByFeature = new Map();
  const allChildIds = new Set();

  featureIds.forEach(featureId => {
    if (unavailableFeatureIds.has(featureId)) {
      return;
    }

    const feature = featuresById.get(featureId);

    if (!feature) {
      unavailableFeatureIds.add(featureId);
      return;
    }

    const childIds = getDirectChildWorkItemIds(feature);

    childIdsByFeature.set(featureId, childIds);

    childIds.forEach(childId => {
      allChildIds.add(childId);
    });
  });

  const {
    workItemsById,
    unavailableWorkItemIds
  } = allChildIds.size > 0
    ? await fetchFeatureStoryWorkItemsBatch(c, [...allChildIds])
    : {
        workItemsById: new Map(),
        unavailableWorkItemIds: new Set()
      };

  featureIds.forEach(featureId => {
    if (unavailableFeatureIds.has(featureId)) {
      return;
    }

    const childIds = childIdsByFeature.get(featureId) || [];

    /*
      Si falta incluso uno de los hijos de este Feature, no es correcto
      devolver una lista parcial como si fuese completa.
    */
    const hasUnavailableChild = childIds.some(childId =>
      unavailableWorkItemIds.has(childId)
    );

    if (hasUnavailableChild) {
      unavailableFeatureIds.add(featureId);
      return;
    }

    results[featureId] = childIds
      .map(childId => workItemsById.get(childId))
      .filter(Boolean)
      .filter(workItem =>
        workItem.workItemType === 'User Story' ||
        workItem.workItemType === 'Bug'
      );
  });

  /* Para IDs no disponibles se conserva results[id]: [] por consistencia estructural, pero el frontend debe usar unavailableFeatureIds para no
    confundir este caso con "sin Stories/Bugs". */
  return {
    results,
    unavailableFeatureIds: [...unavailableFeatureIds]
  };
}

function formatWiqlDateTime(date) {
  return `'${date.toISOString().replace('.000Z', 'Z')}'`;
}

/*
  Convierte expresiones internas basadas en @today a una medianoche real
  en America/Chicago y devuelve el instante UTC equivalente.

  Ejemplo durante CDT:
  - @today para 2026-08-30 en America/Chicago
  - límite UTC resultante: 2026-08-30T05:00:00Z

  Cuando Chicago cambia entre CST y CDT, Luxon ajusta el offset de forma
  automática. Por eso no se deben sumar 24 horas manualmente en UTC.
*/
function getUtcDateFromTodayExpression(expression) {
  const normalizedExpression = String(expression || '')
    .trim()
    .replace(/\s+/g, ' ');

  const todayInBusinessZone = DateTime
    .now()
    .setZone(DASHBOARD_TIME_ZONE)
    .startOf('day');

  if (normalizedExpression === '@today') {
    return todayInBusinessZone.toUTC().toJSDate();
  }

  const match = normalizedExpression.match(
    /^@today\s*([+-])\s*(\d+)$/
  );

  if (!match) {
    throw new Error(
      `Unable to resolve unsupported WIQL date expression: "${expression}".`
    );
  }

  const operator = match[1];
  const days = Number(match[2]);

  if (!Number.isInteger(days)) {
    throw new Error(
      `Unable to parse WIQL date expression: "${expression}".`
    );
  }

  const result = todayInBusinessZone.plus({
    days: operator === '+' ? days : -days
  });

  return result.toUTC().toJSDate();
}

/*
  Construye siempre límites explícitos UTC para WIQL.
  Aunque los objetos de rango sigan usando textos como "@today - 10" internamente para logs y cache keys, Azure DevOps ya no recibe macros.
  Así la evaluación temporal no depende de la zona horaria de ADO.
*/
function buildChangedDateFilter(range) {
  const {
    fromDate,
    toDate
  } = getRangeDateBounds(range);

  const fromValue = formatWiqlDateTime(fromDate);
  const toValue = formatWiqlDateTime(toDate);

  return (
    `[System.ChangedDate] >= ${fromValue} ` +
    `AND [System.ChangedDate] < ${toValue}`
  );
}

/* Devuelve límites Date para un rango. Los rangos originales tienen from/to con expresiones internas como
  "@today - 10". Los subrangos generados automáticamente tienen fromDate/toDate explícitos. */
function getRangeDateBounds(range) {
  const fromDate = range.fromDate
    ? new Date(range.fromDate)
    : getUtcDateFromTodayExpression(range.from);

  const toDate = range.toDate
    ? new Date(range.toDate)
    : getUtcDateFromTodayExpression(range.to);

  if (
    Number.isNaN(fromDate.getTime()) ||
    Number.isNaN(toDate.getTime()) ||
    fromDate >= toDate
  ) {
    throw new Error(
      'Unable to split WIQL range because its date boundaries are invalid.'
    );
  }

  return {
    fromDate,
    toDate
  };
}

/* Ejecuta una consulta WIQL individual. 
timePrecision=true es importante para las consultas subdivididas: permite trabajar con límites exactos de fecha y hora cuando un rango debe partirse en dos. */

async function fetchIdsForSingleRange(
  c,
  range,
  additionalFilter = ''
) {
  const response = await withAdoRetry(() =>
    c.post('/wit/wiql?timePrecision=true&api-version=7.0', {
      query:
        'SELECT [System.Id], [System.Title] ' +
        'FROM workitems ' +
        'WHERE [System.WorkItemType] = "Feature" ' +
        `AND ${buildChangedDateFilter(range)} ` +
        `${BASE_FILTER} ` +
        `${additionalFilter ? `AND ${additionalFilter}` : ''}`
    })
  );

  return (response.data?.workItems || [])
    .map(item => Number(item.id))
    .filter(Number.isInteger);
}

/*
  Convierte un rango WIQL a un texto legible para logs y para el contrato
  técnico rangeDetails.

  Los rangos originales conservan expresiones como:
    @today - 180 to @today - 90

  Los subrangos generados automáticamente usan límites UTC concretos:
    2026-02-29T00:00:00.000Z to 2026-04-14T12:00:00.000Z
*/
function getWiqlRangeLabel(range) {
  const from = range.from ||
    (range.fromDate instanceof Date
      ? range.fromDate.toISOString()
      : new Date(range.fromDate).toISOString());

  const to = range.to ||
    (range.toDate instanceof Date
      ? range.toDate.toISOString()
      : new Date(range.toDate).toISOString());

  return `${from} to ${to}`;
}

/*
  Convierte un rango, original o subdividido, a un objeto seguro para
  observabilidad. No contiene credenciales ni datos de Features.
*/
function getWiqlRangeBoundsForDetails(range) {
  const {
    fromDate,
    toDate
  } = getRangeDateBounds(range);

  return {
    from: fromDate.toISOString(),
    to: toDate.toISOString()
  };
}

/*
  Ejecuta una consulta WIQL y, cuando recibe 200 elementos, divide el
  intervalo recursivamente.

  Devuelve información interna completa para que la función pública pueda:
  - combinar IDs;
  - contar todas las consultas realizadas;
  - identificar si hubo partición;
  - exponer únicamente los subrangos finales no saturados.
*/
async function fetchIdsForRangeInternal(
  c,
  range,
  additionalFilter = ''
) {
  const ids = await fetchIdsForSingleRange(
    c,
    range,
    additionalFilter
  );
  const rangeBounds = getWiqlRangeBoundsForDetails(range);

  /*
    Un resultado menor a 200 se considera completo para este subrango.
    Es un subrango final o "leaf range".
  */
  if (ids.length < WIQL_SATURATION_LIMIT) {
    return {
      ids,
      wasSplit: false,
      subQueryCount: 1,
      leafRanges: [
        {
          ...rangeBounds,
          count: ids.length
        }
      ]
    };
  }

  const {
    fromDate,
    toDate
  } = getRangeDateBounds(range);

  const rangeDurationMs = toDate.getTime() - fromDate.getTime();

  if (rangeDurationMs <= WIQL_MINIMUM_RANGE_MS) {
    throw new Error(
      'WIQL range remained saturated with 200 items even after ' +
      'splitting down to one minute. Data retrieval was stopped to ' +
      'avoid returning an incomplete Feature list.'
    );
  }

  const midpointMs =
    fromDate.getTime() + Math.floor(rangeDurationMs / 2);

  const midpointDate = new Date(midpointMs);

  /*
    El punto medio debe estar estrictamente entre ambos límites.
    Esta protección evita una recursión infinita si el rango no puede
    reducirse correctamente.
  */
  if (
    midpointDate <= fromDate ||
    midpointDate >= toDate
  ) {
    throw new Error(
      'Unable to create a smaller WIQL range while resolving ' +
      'a saturated result set.'
    );
  }

  console.warn('Splitting saturated WIQL Feature range', {
    range: getWiqlRangeLabel(range),
    returnedItems: ids.length,
    midpoint: midpointDate.toISOString()
  });

  /*
    La ejecución de ambos lados permanece secuencial para no aumentar
    el riesgo de throttling hacia Azure DevOps.
  */
  const leftResult = await fetchIdsForRangeInternal(
    c,
    {
      fromDate,
      toDate: midpointDate
    },
    additionalFilter
  );

  const rightResult = await fetchIdsForRangeInternal(
    c,
    {
      fromDate: midpointDate,
      toDate
    },
    additionalFilter
  );

  return {
    /*
      Los subrangos no se solapan por diseño:
        izquierda: >= from y < midpoint
        derecha:   >= midpoint y < to

      La deduplicación se conserva como protección adicional.
    */
    ids: [
      ...new Set([
        ...leftResult.ids,
        ...rightResult.ids
      ])
    ],

    wasSplit: true,

    /*
      Incluye:
      - la consulta original saturada;
      - todas las subconsultas ejecutadas en ambos lados.
    */
    subQueryCount:
      1 +
      leftResult.subQueryCount +
      rightResult.subQueryCount,

    /*
      Solo se conservan los rangos finales que devolvieron menos de 200.
      Esto permite revisar cómo se resolvió el rango original.
    */
    leafRanges: [
      ...leftResult.leafRanges,
      ...rightResult.leafRanges
    ]
  };
}

/*
  Contrato público para el resto del backend.

  Antes:
    const ids = await fetchIdsForRange(c, range);

  Después:
    const result = await fetchIdsForRange(c, range);
    result.ids;
    result.rangeDetail;

  rangeCounts conserva únicamente el total numérico actual, mientras
  rangeDetails agrega la trazabilidad técnica sin romper el frontend.
*/
async function fetchIdsForRange(
  c,
  range,
  additionalFilter = ''
) {
  const internalResult = await fetchIdsForRangeInternal(
    c,
    range,
    additionalFilter
  );

  const rangeDetail = {
    total: internalResult.ids.length,
    complete: true,
    wasSplit: internalResult.wasSplit,
    subQueryCount: internalResult.subQueryCount,
    subRanges: internalResult.leafRanges
  };

  console.log('WIQL Feature range completed', {
    range: getWiqlRangeLabel(range),
    ...rangeDetail
  });

  return {
    ids: internalResult.ids,
    rangeDetail
  };
}

// ===== Trae campos y relaciones de Features en lotes de 200 =====
// Cada verificación conserva la diferencia entre:
// - dato consultado correctamente ("ok")
// - dato que no se pudo obtener ("unknown")
async function fetchFeatureDetailsBatch(c, ids) {
  /* Se consulta una sola vez por ejecución de fetchFeatureDetailsBatch. Redis evita una llamada adicional a Azure DevOps durante 15 minutos. */
  const iterationsByPath = await getIterationCalendar(c);
  const batchSize = 200;
  let allFeatures = [];

  for (let i = 0; i < ids.length; i += batchSize) {
    const currentIds = ids.slice(i, i + batchSize);

    const [fieldsResult, relationsResult] = await Promise.allSettled([
      withAdoRetry(() =>
        c.post('/wit/workitemsbatch?api-version=7.0', {
          ids: currentIds,
          fields: FEATURE_FIELDS,
          errorPolicy: 'Omit'
        })
      ),

      withAdoRetry(() =>
        c.post('/wit/workitemsbatch?api-version=7.0', {
          ids: currentIds,
          $expand: 'Relations',
          errorPolicy: 'Omit'
        })
      )
    ]);
    
    // Si falla la consulta de campos, se registra el problema,
    // pero no se marca el contenido como "faltante": será "unknown".
    if (fieldsResult.status === 'rejected') {
      const error = fieldsResult.reason;

      console.error('ERROR fetching Feature fields batch from ADO', {
        batchStart: i,
        batchSize: currentIds.length,
        adoStatus: error.response?.status || null,
        adoStatusText: error.response?.statusText || null,
        adoResponse: error.response?.data || null,
        message: error.message
      });
    }

    // Si falla la consulta de relaciones, Parent será "unknown",
    // no false.
    if (relationsResult.status === 'rejected') {
      const error = relationsResult.reason;

      console.error('ERROR fetching Feature relations batch from ADO', {
        batchStart: i,
        batchSize: currentIds.length,
        adoStatus: error.response?.status || null,
        adoStatusText: error.response?.statusText || null,
        adoResponse: error.response?.data || null,
        message: error.message
      });
    }

    const fieldsResponse =
      fieldsResult.status === 'fulfilled'
        ? fieldsResult.value.data.value || []
        : [];

    const relationsResponse =
      relationsResult.status === 'fulfilled'
        ? relationsResult.value.data.value || []
        : [];

    // Permite distinguir entre:
    // - Feature recibida sin relaciones: no tiene Parent => false.
    // - Feature no recibida en la consulta de relaciones: unknown.
    const fieldsById = new Map(
      fieldsResponse.map(workItem => [workItem.id, workItem])
    );

    const relationsById = new Map(
      relationsResponse.map(workItem => [workItem.id, workItem])
    );

    // Conservamos todos los IDs solicitados, incluso si ADO omitió alguno.
        const mergedFeatures = currentIds.map(id => {
      const fieldsWorkItem = fieldsById.get(id);
      const relationsWorkItem = relationsById.get(id);

      return {
        id,

        // Si no se pudieron obtener los campos, se deja vacío.
        // mapFeature usará _healthSource para devolver "unknown".
        fields: fieldsWorkItem?.fields || {},

        // Una lista vacía solo significa "sin Parent" cuando la consulta
        // de relaciones sí devolvió este work item.
        relations: relationsWorkItem?.relations || [],

        _healthSource: {
          fields:
            fieldsResult.status === 'fulfilled' && fieldsWorkItem
              ? 'ok'
              : 'unknown',

          relations:
            relationsResult.status === 'fulfilled' && relationsWorkItem
              ? 'ok'
              : 'unknown'
        }
      };
    });

    // Delivery Health no debe impedir que /api/features funcione.
    // Si falla la consulta masiva de hijos, retornamos el Feature con
    // deliverySummary: unknown y conservamos Readiness Health operativo.
    let enrichedFeatures = mergedFeatures.map(feature => ({
      ...feature,
      deliverySummary: buildDeliverySummary([], 'unknown')
    }));

    try {
      enrichedFeatures = await enrichFeaturesWithDeliverySummary(
        c,
        mergedFeatures,
        iterationsByPath
      );
    } catch (error) {
      console.error('ERROR enriching Features with Delivery Health summary', {
        batchStart: i,
        batchSize: currentIds.length,
        errorName: error.name || 'Error',
        message: error.message || 'Unknown error',
        adoStatus: error.response?.status || null,
        adoStatusText: error.response?.statusText || null,
        adoResponse: error.response?.data || null,
        stack: error.stack || null
      });
    }

    allFeatures = [...allFeatures, ...enrichedFeatures];
  }

  return allFeatures;
}

// ===== Features editadas en los ÚLTIMOS 10 días (SIEMPRE en vivo) =====
async function fetchRecentFeatures(c) {
  const range = {
    from: `@today - ${RECENT_DAYS_THRESHOLD}`,
    to: '@today + 1'
  };

  const rangeKey = `${range.from} to ${range.to}`;
  const rangeCounts = {};
  const rangeDetails = {};
  let ids = [];

  try {
    const rangeResult = await fetchIdsForRange(c, range);

    ids = rangeResult.ids;
    rangeCounts[rangeKey] = ids.length;
    rangeDetails[rangeKey] = rangeResult.rangeDetail;
  } catch (error) {
    rangeCounts[rangeKey] = `ERROR: ${error.message}`;

    /*
      El contrato de rangeDetails también comunica que no fue posible
      confirmar la recuperación completa de ese rango.
    */
    rangeDetails[rangeKey] = {
      total: null,
      complete: false,
      wasSplit: false,
      subQueryCount: 0,
      subRanges: []
    };
  }

  const raw = ids.length
    ? await fetchFeatureDetailsBatch(c, ids)
    : [];

  return {
    features: raw.map(mapFeature),
    rangeCounts,
    rangeDetails
  };
}

/*
  Recupera un único rango histórico.

  Este resultado se guarda de manera independiente en Redis.
  Así, un error en un rango no obliga a descartar los demás rangos
  históricos que sí pudieron actualizarse correctamente.
*/
async function fetchOldFeaturesRange(c, range) {
  const rangeKey = getOldFeaturesRangeLabel(range);

  try {
    const rangeResult = await fetchIdsForRange(c, range);

    const raw = rangeResult.ids.length
      ? await fetchFeatureDetailsBatch(c, rangeResult.ids)
      : [];

    return {
      range,
      rangeKey,
      features: raw.map(mapFeature),
      rangeCount: rangeResult.ids.length,
      rangeDetail: rangeResult.rangeDetail,
      complete: true,
      error: null
    };
  } catch (error) {
    return {
      range,
      rangeKey,
      features: [],
      rangeCount: `ERROR: ${error.message}`,
      rangeDetail: {
        total: null,
        complete: false,
        wasSplit: false,
        subQueryCount: 0,
        subRanges: [],
        error: error.message
      },
      complete: false,
      error
    };
  }
}

/*
  Construye el objeto persistido para un rango individual.

  Cada shard contiene todo lo necesario para reconstruir la respuesta
  histórica sin depender de los otros rangos.
*/
function createOldFeaturesRangeCacheEntry(result, timestamp) {
  return {
    data: result.features,
    rangeCount: result.rangeCount,
    rangeDetail: result.rangeDetail,
    timestamp
  };
}

/*
  Convierte los shards incrementales en el contrato histórico que ya
  consume /api/features.

  El timestamp global se calcula usando el shard más antiguo. De ese modo,
  cacheInfo.ageMinutes representa la antigüedad de la parte menos reciente
  del caché histórico, evitando presentar datos viejos como si acabaran
  de actualizarse.
*/
function buildOldFeaturesCacheFromRangeEntries(rangeEntries) {
  const data = [];
  const rangeCounts = {};
  const rangeDetails = {};
  const timestamps = [];
  const historicalRanges = [];

  OLD_FEATURES_DATE_RANGES.forEach(range => {
    const rangeKey = getOldFeaturesRangeLabel(range);
    const entry = rangeEntries.get(range.cacheSuffix);

    if (!entry) {
      return;
    }

    const rangeData = entry.data || [];
    const rangeDetail = entry.rangeDetail || {
      total: null,
      complete: false,
      wasSplit: false,
      subQueryCount: 0,
      subRanges: []
    };

    const timestamp = Number(entry.timestamp);

    data.push(...rangeData);

    rangeCounts[rangeKey] =
      entry.rangeCount !== undefined
        ? entry.rangeCount
        : 0;

    rangeDetails[rangeKey] = rangeDetail;

    if (Number.isFinite(timestamp)) {
      timestamps.push(timestamp);
    }

    /*
      Metadatos individuales de cada shard.

      Esto permite que el dashboard muestre claramente qué rango se
      actualizó, cuándo se actualizó y cuántos Features contiene, sin
      tener que inferirlo desde el caché global.
    */
    historicalRanges.push({
      cacheKey: getOldFeaturesRangeCacheKey(range),
      cacheSuffix: range.cacheSuffix,

      range: {
        from: range.from,
        to: range.to,
        label: rangeKey
      },

      featureCount: rangeData.length,

      /*
        rangeCount representa el resultado WIQL antes de obtener los
        detalles del Feature. Normalmente coincide con featureCount.
      */
      wiqlCount:
        entry.rangeCount !== undefined
          ? entry.rangeCount
          : 0,

      lastRefresh:
        Number.isFinite(timestamp)
          ? new Date(timestamp).toISOString()
          : null,

      timestamp:
        Number.isFinite(timestamp)
          ? timestamp
          : null,

      wasSplit: Boolean(rangeDetail.wasSplit),

      subQueryCount:
        Number(rangeDetail.subQueryCount || 0),

      complete:
        rangeDetail.complete !== false
    });
  });

  return {
    data,
    rangeCounts,
    rangeDetails,

    /*
      El timestamp global sigue representando el shard más antiguo.
      Esto evita presentar todo el histórico como reciente si solo
      algunos rangos fueron reconstruidos más tarde.
    */
    timestamp:
      timestamps.length > 0
        ? Math.min(...timestamps)
        : Date.now(),

    /*
      Propiedad aditiva. El frontend actual puede ignorarla y no se
      rompe ningún consumidor existente.
    */
    historicalRanges
  };
}

/*
  Lee o actualiza el caché incremental histórico.

  Reglas de seguridad:
  - Un rango se sobrescribe solo si se recuperó completamente.
  - Si un rango falla y tiene shard previo, se conserva ese shard.
  - Si falta un shard y falla ADO, se usa el caché legado completo
    como fallback temporal, si existe.
  - Si no hay shard suficiente ni caché legado válido, se devuelve 503.
*/
async function getIncrementalOldFeaturesCache(
  c,
  {
    legacyOldFeaturesCache,
    forceRefresh = false
  }
) {
  const rangeEntries = new Map();
  const cacheRefreshWarnings = [];
  const failedRanges = [];
  let usedLegacyFallback = false;

  /*
    Primero leemos todos los shards existentes.

    Se leen antes de iniciar consultas ADO para que cada rango tenga una
    versión previa segura disponible en caso de fallo durante refresh.
  */
  const existingEntries = await Promise.all(
    OLD_FEATURES_DATE_RANGES.map(async range => {
      const cacheKey = getOldFeaturesRangeCacheKey(range);
      const entry = await redis.get(cacheKey);

      return {
        range,
        entry
      };
    })
  );

  /* Los shards históricos se consultan cuando:
  - no existen en Redis;
  - su TTL expiró;
  - el Cron interno solicita forceRefresh=true.
  El Refresh manual del dashboard nunca usa forceRefresh: los Features Live se consultan siempre mediante fetchRecentFeatures(). */
  const rangesToRefresh = OLD_FEATURES_DATE_RANGES.filter(range => {
    const existing = existingEntries.find(
      item => item.range.cacheSuffix === range.cacheSuffix
    );
  
    /*
      El endpoint público nunca envía forceRefresh=true.
  
      Sólo el Cron interno puede solicitar una actualización explícita de
      los shards históricos ya existentes.
    */
    return forceRefresh || !existing?.entry;
  });

  /*
    Los rangos existentes que no necesitan actualizarse se conservan
    directamente en memoria.
  */
  existingEntries.forEach(({ range, entry }) => {
    if (entry) {
      rangeEntries.set(range.cacheSuffix, entry);
    }
  });

  /*
  Ejecutamos los shards históricos inexistentes, expirados o solicitados explícitamente por el Cron interno.

  El Refresh manual del dashboard no llega aquí con forceRefresh=true: sólo vuelve a consultar Features Live mediante fetchRecentFeatures().
  */
  const refreshResults = await mapWithConcurrency(
    rangesToRefresh,
    OLD_FEATURES_RANGE_CONCURRENCY,
    async range => {
      const result = await fetchOldFeaturesRange(c, range);

      const existingEntry = existingEntries.find(
        item => item.range.cacheSuffix === range.cacheSuffix
      )?.entry;

      if (result.complete) {
        const newEntry = createOldFeaturesRangeCacheEntry(
          result,
          Date.now()
        );

        await redis.set(
          getOldFeaturesRangeCacheKey(range),
          newEntry,
          {
            ex: OLD_FEATURES_CACHE_TTL_SECONDS
          }
        );

        return {
          range,
          entry: newEntry,
          refreshed: true,
          failed: false
        };
      }

      failedRanges.push({
        range: result.rangeKey,
        error: result.error?.message || 'Unknown error'
      });

      /*
        Si este rango tenía una versión previa válida, se conserva.
        No se renueva su TTL para no mantener datos históricos
        indefinidamente si ADO continúa fallando.
      */
      if (existingEntry) {
        console.error(
          'Historical Feature range refresh was incomplete. ' +
          'Keeping the previous valid Redis range cache.',
          {
            range: result.rangeKey,
            error: result.error?.message || 'Unknown error'
          }
        );

        cacheRefreshWarnings.push(
          `WARNING: Historical range "${result.rangeKey}" ` +
          'could not be refreshed. The dashboard is showing the ' +
          'last successful cached data for that range.'
        );

        return {
          range,
          entry: existingEntry,
          refreshed: false,
          failed: true
        };
      }

      /*
        No existe shard previo para este rango. La migración todavía puede
        usar el caché histórico completo anterior como fallback seguro.
      */
      return {
        range,
        entry: null,
        refreshed: false,
        failed: true
      };
    }
  );

  refreshResults.forEach(result => {
    if (result.entry) {
      rangeEntries.set(
        result.range.cacheSuffix,
        result.entry
      );
    }
  });

  const hasAllIncrementalRanges =
    rangeEntries.size === OLD_FEATURES_DATE_RANGES.length;

  /*
    Durante la migración, un caché legado íntegro sigue siendo mejor que
    responder con un subconjunto de rangos incrementales.

    Esto protege el dashboard si el primer deploy con v2 coincide con
    una indisponibilidad parcial de Azure DevOps.
  */
  if (!hasAllIncrementalRanges) {
    if (legacyOldFeaturesCache) {
      usedLegacyFallback = true;

      console.error(
        'Incremental historical cache is incomplete. ' +
        'Using the previous legacy historical cache as fallback.',
        {
          availableRangeShards: rangeEntries.size,
          expectedRangeShards: OLD_FEATURES_DATE_RANGES.length,
          failedRanges
        }
      );

      cacheRefreshWarnings.push(
        'WARNING: The incremental historical cache migration is incomplete. ' +
        'The dashboard is showing the last successful legacy cached data.'
      );

      return {
        oldFeaturesCache: legacyOldFeaturesCache,
        cacheRefreshWarnings,
        failedRanges,
        usedLegacyFallback
      };
    }

    /*
      No hay suficientes shards v2 y tampoco existe el caché antiguo.
      Es más seguro responder 503 que mostrar información histórica
      incompleta como si fuera confiable.
    */
    const error = new Error(
      'Historical Features could not be fully retrieved from Azure DevOps.'
    );

    error.statusCode = 503;
    error.failedRanges = failedRanges;

    throw error;
  }

  return {
    oldFeaturesCache: buildOldFeaturesCacheFromRangeEntries(
      rangeEntries
    ),
    cacheRefreshWarnings,
    failedRanges,
    usedLegacyFallback
  };
}

/* Recupera Features no terminales cuyo último cambio ocurrió entre 180 y 730 días atrás.
  La ventana móvil evita consultar toda la historia del proyecto desde una fecha fija. Si la consulta alcanza el límite de 200 IDs,
  fetchIdsForRange() la divide automáticamente en subrangos UTC. */
async function fetchActiveOldFeatures(c) {
  const range = {
    from: `@today - ${ACTIVE_OLD_FEATURES_MAX_AGE_DAYS}`,
    to: `@today - ${ACTIVE_OLD_FEATURES_MIN_AGE_DAYS}`
  };

  const rangeKey =
    `Active Features changed from @today - ` +
    `${ACTIVE_OLD_FEATURES_MAX_AGE_DAYS} to @today - ` +
    `${ACTIVE_OLD_FEATURES_MIN_AGE_DAYS}`;

  const activeStateFilter = buildActiveFeatureStateFilter();

  try {
    const rangeResult = await fetchIdsForRange(
      c,
      range,
      activeStateFilter
    );

    const raw = rangeResult.ids.length
      ? await fetchFeatureDetailsBatch(c, rangeResult.ids)
      : [];

    return {
      data: raw.map(mapFeature),
      rangeCount: rangeResult.ids.length,
      rangeDetail: rangeResult.rangeDetail,
      timestamp: Date.now()
    };
  } catch (error) {
    error.rangeKey = rangeKey;
    throw error;
  }
}

/* Lee o actualiza el caché de Features activos con cambios entre 180 y 730 días atrás.
  forceRefresh sólo se usa desde el Cron interno. El botón Refresh del dashboard nunca fuerza este caché. */
async function getActiveOldFeaturesCache(
  c,
  {
    forceRefresh = false
  } = {}
) {
  const existingEntry = await redis.get(
    ACTIVE_OLD_FEATURES_CACHE_KEY
  );

  /*
    Mientras el shard exista y no sea una sincronización interna
    programada, se reutiliza sin consultar Azure DevOps.
  */
  if (existingEntry && !forceRefresh) {
    return {
      activeOldFeaturesCache: existingEntry,
      warning: null,
      usedPreviousCache: false,
      refreshed: false
    };
  }

  try {
    const newEntry = await fetchActiveOldFeatures(c);

    await redis.set(
      ACTIVE_OLD_FEATURES_CACHE_KEY,
      newEntry,
      {
        ex: OLD_FEATURES_CACHE_TTL_SECONDS
      }
    );

    return {
      activeOldFeaturesCache: newEntry,
      warning: null,
      usedPreviousCache: false,
      refreshed: true
    };
  } catch (error) {
    /*
      Durante el Cron, un shard previo válido sigue siendo preferible a
      reemplazarlo por información parcial o hacer fallar todo el proceso.
    */
    if (existingEntry) {
      console.error(
        'Active old Features cache refresh failed. ' +
        'Keeping the previous valid Redis cache.',
        {
          cacheKey: ACTIVE_OLD_FEATURES_CACHE_KEY,
          range: error.rangeKey || null,
          adoStatus: error.response?.status || null,
          message: error.message
        }
      );

      return {
        activeOldFeaturesCache: existingEntry,
        warning:
          'WARNING: Active historical Features could not be refreshed. ' +
          'The dashboard is showing the last successful cached data.',
        usedPreviousCache: true,
        refreshed: false
      };
    }

    console.error(
      'Unable to build the active old Features cache.',
      {
        cacheKey: ACTIVE_OLD_FEATURES_CACHE_KEY,
        range: error.rangeKey || null,
        adoStatus: error.response?.status || null,
        message: error.message
      }
    );

    const cacheError = new Error(
      'Active historical Features could not be fully retrieved from Azure DevOps.'
    );

    cacheError.statusCode = 503;

    throw cacheError;
  }
}

/* Lock distribuido del Cron. No se elimina manualmente al terminar: expira automáticamente.
  Esto evita que una ejecución lenta borre accidentalmente el lock de una ejecución posterior que hubiera empezado después de expirar.
  El endpoint es idempotente: si Vercel entrega un evento duplicado, el segundo intento detecta el lock y finaliza sin ejecutar otra
  sincronización en paralelo. */

const FEATURE_CACHE_SYNC_LOCK_KEY =
  'oldFeaturesCache:v2:scheduled-sync-lock';

const FEATURE_CACHE_SYNC_LOCK_TTL_SECONDS =
  55 * 60;

/*
  Compara secretos sin revelar diferencias de longitud o contenido por
  el tiempo de respuesta.
*/
function hasValidCronAuthorization(req) {
  const authorization = String(
    req.get('authorization') || ''
  );

  const expectedValue = `Bearer ${CRON_SECRET}`;

  const authorizationBuffer = Buffer.from(authorization);
  const expectedBuffer = Buffer.from(expectedValue);

  if (authorizationBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    authorizationBuffer,
    expectedBuffer
  );
}

/*
  Intenta obtener el lock sin sobrescribir un lock vigente.

  Redis devuelve null cuando otro proceso ya posee la clave. El valor
  exacto devuelto puede variar por cliente, por lo que sólo consideramos
  adquisición exitosa cualquier respuesta distinta de null.
*/
async function tryAcquireFeatureCacheSyncLock() {
  const result = await redis.set(
    FEATURE_CACHE_SYNC_LOCK_KEY,
    {
      startedAt: new Date().toISOString()
    },
    {
      nx: true,
      ex: FEATURE_CACHE_SYNC_LOCK_TTL_SECONDS
    }
  );

  return result !== null;
}

app.get('/api/health', (req, res) => res.json({ ok: 1 }));

/*
  Endpoint exclusivo para Vercel Cron.

  No utiliza /api/features porque:
  - no necesita ejecutar la consulta Live;
  - no debe devolver la lista completa de Features;
  - debe actualizar explícitamente los shards históricos;
  - necesita un lock para evitar sincronizaciones concurrentes.
*/
app.get(
  '/api/internal/sync-feature-caches',
  async (req, res) => {
    if (!hasValidCronAuthorization(req)) {
      console.warn(
        'Rejected unauthorized feature cache sync request.'
      );

      return res.status(401).json({
        error: 'Unauthorized.'
      });
    }

    let lockAcquired = false;

    try {
      lockAcquired = await tryAcquireFeatureCacheSyncLock();

      if (!lockAcquired) {
        console.warn(
          'Feature cache sync skipped because another run is active.'
        );

        return res.status(409).json({
          ok: false,
          skipped: true,
          reason: 'A feature cache synchronization is already running.'
        });
      }

      const startedAt = Date.now();
      const c = getAdoClient();

      /*
        El caché legado se conserva como fallback durante la migración.
        Una vez que oldFeaturesCache deje de ser necesario, este bloque
        podrá simplificarse junto con la retirada del fallback legado.
      */
      const legacyOldFeaturesCache = await redis.get(
        LEGACY_OLD_FEATURES_CACHE_KEY
      );

      /*
        El Cron sí fuerza una actualización histórica.

        Cada shard conserva su propia protección:
        - éxito completo => se escribe el nuevo shard;
        - fallo + shard previo => se conserva el shard previo;
        - shard faltante + legacy disponible => fallback legado;
        - sin datos seguros disponibles => error 503.
      */
      const historicalResult =
        await getIncrementalOldFeaturesCache(
          c,
          {
            legacyOldFeaturesCache,
            forceRefresh: true
          }
        );

      /*
        El rango de Features activos entre 180 y 730 días también se
        actualiza en el Cron, no desde el Refresh manual del dashboard.
      */
      const activeOldResult =
        await getActiveOldFeaturesCache(
          c,
          {
            forceRefresh: true
          }
        );

      const durationMs = Date.now() - startedAt;

      console.log(
        'Feature cache synchronization completed.',
        {
          durationMs,
          storageMode:
            historicalResult.usedLegacyFallback
              ? 'legacy-fallback'
              : 'incremental-v2',
          historicalFailedRanges:
            historicalResult.failedRanges.length,
          activeOldUsedPreviousCache:
            activeOldResult.usedPreviousCache,
          activeOldRefreshed:
            activeOldResult.refreshed
        }
      );

      return res.status(200).json({
        ok: true,
        storageMode:
          historicalResult.usedLegacyFallback
            ? 'legacy-fallback'
            : 'incremental-v2',
        historicalFailedRanges:
          historicalResult.failedRanges.length,
        activeOldUsedPreviousCache:
          activeOldResult.usedPreviousCache,
        activeOldRefreshed:
          activeOldResult.refreshed,
        durationMs
      });
    } catch (error) {
      console.error(
        'ERROR /api/internal/sync-feature-caches',
        {
          errorName: error.name || 'Error',
          message: error.message || 'Unknown error',
          statusCode: error.statusCode || null,
          adoStatus: error.response?.status || null,
          errorCode: error.code || null,
          stack: error.stack || null
        }
      );

      return res.status(
        error.statusCode || 500
      ).json({
        error:
          error.statusCode === 503
            ? 'Feature caches could not be fully synchronized. Please try again later.'
            : 'Unable to synchronize Feature caches.'
      });
    }
  }
);

app.get('/api/feature-history/:id', async (req, res) => {
  try {
    const featureId = Number(req.params.id);

    if (!Number.isInteger(featureId) || featureId <= 0) {
      return res.status(400).json({
        error: 'Invalid Feature ID.'
      });
    }

    const c = getAdoClient();

    console.log('Fetching history for feature:', featureId);

    const revisionsResponse = await withAdoRetry(() =>
      c.get(`/wit/workitems/${featureId}/revisions?api-version=7.0`)
    );

    const revisions = revisionsResponse.data?.value || [];
    const stateChanges = getStateChangesFromRevisions(revisions);

    return res.json({
      id: featureId,
      stateChanges,
      totalRevisions: revisions.length
    });
  } catch (error) {
    console.error('ERROR /api/feature-history/:id', {
      featureId: req.params.id,
      adoStatus: error.response?.status || null,
      adoStatusText: error.response?.statusText || null,
      adoResponse: error.response?.data || null,
      errorCode: error.code || null,
      message: error.message
    });

    /* La respuesta pública no debe incluir error.response.data.
      Azure DevOps puede devolver detalles internos, estructuras, mensajes técnicos o información no pensada para usuarios. */
    return res.status(500).json({
      error: 'Unable to fetch Feature history from Azure DevOps.'
    });
  }
});

app.post('/api/features-history-batch', async (req, res) => {
  try {
    if (!Array.isArray(req.body?.ids)) {
      return res.status(400).json({
        error: 'The request body must contain an "ids" array.'
      });
    }
    /* Normaliza, elimina IDs inválidos y evita consultar dos veces el mismo Feature si llega duplicado en la petición. */
    const ids = [
      ...new Set(
        req.body.ids
          .map(Number)
          .filter(id => Number.isInteger(id) && id > 0)
      )
    ];
    if (ids.length > MAX_HISTORY_BATCH_IDS) {
      return res.status(400).json({
        error: `A maximum of ${MAX_HISTORY_BATCH_IDS} IDs is allowed per history batch request.`
      });
    }
    const c = getAdoClient();
    const results = {};
    await mapWithConcurrency(
      ids,
      HISTORY_BATCH_CONCURRENCY,
      async id => {
        try {
          const revisionsResponse = await withAdoRetry(() =>
            c.get(`/wit/workitems/${id}/revisions?api-version=7.0`)
          );
          results[id] = getStateChangesFromRevisions(
            revisionsResponse.data?.value || []
          );
        } catch (error) {
          /* Un Feature fallido no debe impedir que el dashboard reciba el historial de los otros Features. */
          console.error('ERROR fetching Feature history from ADO', {
            featureId: id,
            adoStatus: error.response?.status || null,
            adoStatusText: error.response?.statusText || null,
            adoResponse: error.response?.data || null,
            message: error.message
          });
          // Conserva el contrato actual con el frontend.
          results[id] = [];
        }
      }
    );

    return res.json({ results });
  } catch (error) {
    console.error('ERROR /api/features-history-batch', {
      message: error.message,
      stack: error.stack || null
    });
    return res.status(500).json({
      error: 'Unable to fetch Feature histories from ADO.'
    });
  }
});

app.get('/api/story-history/:id', async (req, res) => {
  try {
    const storyId = Number(req.params.id);

    if (!Number.isInteger(storyId) || storyId <= 0) {
      return res.status(400).json({
        error: 'Invalid Story/Bug ID.'
      });
    }

    const c = getAdoClient();

    const revisionsResponse = await withAdoRetry(() =>
      c.get(`/wit/workitems/${storyId}/revisions?api-version=7.0`)
    );

    const revisions = revisionsResponse.data?.value || [];
    const stateChanges = getStateChangesFromRevisions(revisions);

    /*
      Se conserva Iteration Path para no romper consumidores existentes
      de este endpoint individual.
    */
    const lastRevision = revisions[revisions.length - 1];
    const iterationPath =
      lastRevision?.fields?.['System.IterationPath'] || null;

    return res.json({
      id: storyId,
      iterationPath,
      stateChanges,
      totalRevisions: revisions.length
    });
  } catch (error) {
    console.error('ERROR /api/story-history/:id', {
      storyId: req.params.id,
      adoStatus: error.response?.status || null,
      adoStatusText: error.response?.statusText || null,
      adoResponse: error.response?.data || null,
      errorCode: error.code || null,
      message: error.message
    });

    /*
      Los detalles técnicos se conservan exclusivamente en logs.
      El navegador recibe un mensaje estable y seguro.
    */
    return res.status(500).json({
      error: 'Unable to fetch Story history from Azure DevOps.'
    });
  }
});

app.post('/api/stories-history-batch', async (req, res) => {
  try {
    if (!Array.isArray(req.body?.ids)) {
      return res.status(400).json({
        error: 'The request body must contain an "ids" array.'
      });
    }

    /*
      Normaliza, elimina IDs inválidos y evita llamadas repetidas
      si el mismo Story/Bug aparece más de una vez.
    */
    const ids = [
      ...new Set(
        req.body.ids
          .map(Number)
          .filter(id => Number.isInteger(id) && id > 0)
      )
    ];

    if (ids.length > MAX_HISTORY_BATCH_IDS) {
      return res.status(400).json({
        error: `A maximum of ${MAX_HISTORY_BATCH_IDS} IDs is allowed per history batch request.`
      });
    }

    const c = getAdoClient();
    const results = {};

    await mapWithConcurrency(
      ids,
      HISTORY_BATCH_CONCURRENCY,
      async id => {
        try {
          const revisionsResponse = await withAdoRetry(() =>
            c.get(`/wit/workitems/${id}/revisions?api-version=7.0`)
          );

          results[id] = getStateChangesFromRevisions(
            revisionsResponse.data?.value || []
          );
        } catch (error) {
          /*
            Se degrada solo este Story/Bug; el resto de la respuesta
            batch continúa disponible.
          */
          console.error('ERROR fetching Story history from ADO', {
            storyId: id,
            adoStatus: error.response?.status || null,
            adoStatusText: error.response?.statusText || null,
            adoResponse: error.response?.data || null,
            message: error.message
          });

          results[id] = [];
        }
      }
    );

    return res.json({ results });
  } catch (error) {
    console.error('ERROR /api/stories-history-batch', {
      message: error.message,
      stack: error.stack || null
    });

    return res.status(500).json({
      error: 'Unable to fetch Story histories from ADO.'
    });
  }
});

/* Nuevo endpoint masivo para Stories/Bugs.
  - results[id] = [] y el ID NO está en unavailableFeatureIds: el Feature realmente no tiene Stories/Bugs directos.
  - results[id] = [] y el ID SÍ está en unavailableFeatureIds: no fue posible recuperar información completa desde ADO. */

app.post('/api/features-stories-batch', async (req, res) => {
  try {
    if (!Array.isArray(req.body?.ids)) {
      return res.status(400).json({
        error: 'The request body must contain an "ids" array.'
      });
    }

    /*
      Normaliza:
      - convierte strings numéricos a number;
      - elimina inválidos;
      - elimina duplicados;
      - evita repetir trabajo hacia ADO.
    */
    const ids = [
      ...new Set(
        req.body.ids
          .map(Number)
          .filter(id => Number.isInteger(id) && id > 0)
      )
    ];

    if (ids.length > MAX_FEATURE_STORIES_BATCH_IDS) {
      return res.status(400).json({
        error:
          `A maximum of ${MAX_FEATURE_STORIES_BATCH_IDS} ` +
          'Feature IDs is allowed per Stories/Bugs batch request.'
      });
    }

    /* Una petición sin IDs es válida y facilita que el frontend mantenga una lógica uniforme al navegar entre páginas sin resultados. */
    if (ids.length === 0) {
      return res.json({
        results: {},
        unavailableFeatureIds: []
      });
    }

    const c = getAdoClient();

    const {
      results,
      unavailableFeatureIds
    } = await fetchStoriesForFeaturesBatch(c, ids);

    return res.json({
      results,
      unavailableFeatureIds
    });
  } catch (error) {
    console.error('ERROR /api/features-stories-batch', {
      adoStatus: error.response?.status || null,
      adoStatusText: error.response?.statusText || null,
      adoResponse: error.response?.data || null,
      message: error.message,
      stack: error.stack || null
    });

    return res.status(500).json({
      error: 'Unable to fetch Feature Stories/Bugs from ADO.'
    });
  }
});

/* Endpoint individual legado.
  Se conserva por compatibilidad temporal con posibles clientes externos o bookmarks técnicos, pero el dashboard ya no lo utilizará después de aplicar los cambios del frontend. */
app.get('/api/feature-stories/:id', async (req, res) => {
  try {
    const featureId = Number(req.params.id);

    if (!Number.isInteger(featureId) || featureId <= 0) {
      return res.status(400).json({
        error: 'Invalid Feature ID.'
      });
    }

    const c = getAdoClient();

    /*
      El endpoint individual reutiliza el mismo flujo batch.
      Así se garantiza que:
      - la interpretación de relaciones directas es idéntica;
      - el mapeo de Stories/Bugs es idéntico;
      - la lógica de unavailable es idéntica.
    */
    const {
      results,
      unavailableFeatureIds
    } = await fetchStoriesForFeaturesBatch(c, [featureId]);

    if (unavailableFeatureIds.includes(featureId)) {
      return res.status(503).json({
        error:
          'Feature Stories/Bugs could not be fully retrieved from ADO.',
        unavailableFeatureIds
      });
    }

    return res.json({
      stories: results[featureId] || []
    });
  } catch (error) {
    console.error('ERROR /api/feature-stories/:id', {
      featureId: req.params.id,
      adoStatus: error.response?.status || null,
      adoStatusText: error.response?.statusText || null,
      adoResponse: error.response?.data || null,
      message: error.message
    });

    return res.status(500).json({
      error: 'Unable to fetch Feature Stories/Bugs from ADO.'
    });
  }
});

/* Endpoint exclusivo para Fase 1 de relaciones.
  No reemplaza:
  - /api/features-stories-batch
  - /api/feature-stories/:id
  - Delivery Health actual
  Permite traer un grafo de: Feature -> Story/Bug -> Bug usando relaciones Child y Related.*/
app.post('/api/features-relationship-graph-batch', async (req, res) => {
  try {
    if (!Array.isArray(req.body?.ids)) {
      return res.status(400).json({
        error: 'The request body must contain an "ids" array.'
      });
    }

    const ids = [
      ...new Set(
        req.body.ids
          .map(Number)
          .filter(id => Number.isInteger(id) && id > 0)
      )
    ];

    if (ids.length > MAX_FEATURE_RELATIONSHIP_BATCH_IDS) {
      return res.status(400).json({
        error:
          `A maximum of ${MAX_FEATURE_RELATIONSHIP_BATCH_IDS} ` +
          'Feature IDs is allowed per relationship graph request.'
      });
    }

    if (ids.length === 0) {
      return res.json({
        results: {},
        unavailableFeatureIds: []
      });
    }

    const c = getAdoClient();

    const {
      results,
      unavailableFeatureIds
    } = await fetchRelationshipGraphsForFeaturesBatch(c, ids);

    return res.json({
      results,
      unavailableFeatureIds
    });
  } catch (error) {
    console.error(
      'ERROR /api/features-relationship-graph-batch',
      {
        adoStatus: error.response?.status || null,
        adoStatusText: error.response?.statusText || null,
        adoResponse: error.response?.data || null,
        message: error.message,
        stack: error.stack || null
      }
    );

    return res.status(500).json({
      error:
        'Unable to fetch Feature relationship graphs from ADO.'
    });
  }
});
  
app.get('/api/features', async (req, res) => {
  try {
    const c = getAdoClient();
    /*  refresh=1 sigue siendo aceptado por compatibilidad con el botón actual del dashboard.
      Los Features recientes siempre se consultan en vivo más abajo, por lo que no es necesario forzar una actualización histórica. */
    const liveRefreshRequested = req.query.refresh === '1';
    const now = Date.now();

    if (liveRefreshRequested) {
      console.log(
        'Manual refresh requested. Refreshing Live Features only.'
      );
    }

    /*
      1. Leer el caché histórico legado.

      Esta clave se conserva temporalmente para que el primer deploy con
      shards incrementales no tenga riesgo de mostrar datos incompletos.
      Cuando confirmemos que los shards v2 están estables durante varios
      ciclos de TTL, esta lectura podrá eliminarse.
    */
    const legacyOldFeaturesCache = await redis.get(
      LEGACY_OLD_FEATURES_CACHE_KEY
    );

   /* 2. Leer o reconstruir únicamente los shards históricos inexistentes o expirados.
      refresh=1 no fuerza estas consultas: el botón manual actualiza sólo los Features Live mediante fetchRecentFeatures(). */
    const {
      oldFeaturesCache,
      cacheRefreshWarnings,
      failedRanges,
      usedLegacyFallback
    } = await getIncrementalOldFeaturesCache(
      c,
      {
        legacyOldFeaturesCache
      }
    );

    /*
      Información adicional exclusivamente para logs.

      No exponemos errores técnicos de Azure DevOps al navegador.
    */
    if (failedRanges.length > 0) {
      console.warn(
        'Historical incremental cache completed with fallback ranges.',
        {
          failedRanges,
          usedLegacyFallback
        }
      );
    }

    /* 3. Features activos con cambios entre 180 y 730 días atrás.
    Este caché separado conserva Features no terminales que ya quedaron fuera de los cinco rangos históricos normales, sin consultar toda la historia del proyecto. */
    const {
      activeOldFeaturesCache,
      warning: activeOldFeaturesWarning,
      usedPreviousCache: usedPreviousActiveOldCache
    } = await getActiveOldFeaturesCache(c);
    
    /* Compatibilidad con cachés existentes creados antes de agregar rangeDetails. Mientras no ocurra un refresh histórico, el API
      responde {} en vez de producir un error. */
        oldFeaturesCache.rangeDetails =
        oldFeaturesCache.rangeDetails || {};

    // 4. La consulta reciente siempre es en vivo; nunca se guarda en Redis.
    const recentResult = await fetchRecentFeatures(c);

    // 5. Deduplicación: si un ID aparece en más de un origen, gana la versión más reciente.
    /* Prioridad de datos, de más reciente a más antiguo:
      1. Live: últimos 10 días.
      2. Histórico incremental: entre 10 y 180 días.
      3. Retención activa: entre 180 y 730 días, únicamente para Features que no estén en estados terminales.
      Aunque los filtros no deberían solaparse, la deduplicación protege contra cambios de fecha, transiciones de estado o reconstrucciones de caché en momentos distintos. */
    const featuresById = new Map();
    [
      ...activeOldFeaturesCache.data,
      ...oldFeaturesCache.data,
      ...recentResult.features
    ].forEach(feature => {
      featuresById.set(feature.id, feature);
    });

    const allFeatures = [...featuresById.values()];

    // 6. Combinar conteos, detalles técnicos y advertencias.
    const activeOldRangeKey =
      `Active Features changed from @today - ` +
      `${ACTIVE_OLD_FEATURES_MAX_AGE_DAYS} to @today - ` +
      `${ACTIVE_OLD_FEATURES_MIN_AGE_DAYS}`;

    const rangeCounts = {
      [activeOldRangeKey]:
        activeOldFeaturesCache.rangeCount,
      ...oldFeaturesCache.rangeCounts,
      ...recentResult.rangeCounts
    };

    /*
      Nueva información técnica y aditiva.

      El frontend actual no necesita consumirla todavía. Se incluye desde
      ahora para que pueda revisarse directamente en /api/features y para
      preparar una futura visualización opcional en el dashboard.
    */
    const rangeDetails = {
      [activeOldRangeKey]:
        activeOldFeaturesCache.rangeDetail,
      ...oldFeaturesCache.rangeDetails,
      ...recentResult.rangeDetails
    };

    /*
      Un conteo >= 200 ya no es warning por sí mismo: la función WIQL
      divide automáticamente los rangos saturados.

      También agregamos advertencias transitorias si un refresh falló
      parcialmente y fue necesario conservar el último caché válido.
    */
    const rangeWarnings = Object.entries(rangeCounts)
      .filter(([, count]) =>
        typeof count === 'string' &&
        count.startsWith('ERROR:')
      )
      .map(([range]) =>
        `WARNING: Range "${range}" could not be fully retrieved from Azure DevOps.`
      );

    const warnings = [
      ...cacheRefreshWarnings,
      ...(activeOldFeaturesWarning
        ? [activeOldFeaturesWarning]
        : []),
      ...rangeWarnings
    ];

    res.json({
      /*
        Configuración temporal compartida con el frontend.
        businessDate representa el día operativo que el backend usó al evaluar Delivery Health durante esta respuesta.
      */
      dashboard: {
        timeZone: DASHBOARD_TIME_ZONE,
        businessDate: getTodayDateKey(),
        /* El calendario se publica con la respuesta principal para evitar una segunda llamada HTTP desde el frontend. */
        releaseCalendar: releaseCalendarByRfv
      },

      rangeCounts,
      rangeDetails,
      warnings,
      total: allFeatures.length,
      cacheInfo: {
        /* En caché incremental, lastRefresh representa el shard histórico más antiguo. Es la referencia más segura para expresar la edad
          real del conjunto histórico completo. */
        lastRefresh: new Date(
          oldFeaturesCache.timestamp
        ).toISOString(),

        ageMinutes: Math.round(
          (now - oldFeaturesCache.timestamp) / 60000
        ),

        storageMode: usedLegacyFallback
          ? 'legacy-fallback'
          : 'incremental-v2',

        historicalRangeCount:
          OLD_FEATURES_DATE_RANGES.length,

       /* Estado del caché adicional que retiene Features activos cuyo último cambio ocurrió entre 180 y 730 días atrás. */
        activeOldFeatures: {
          cacheKey: ACTIVE_OLD_FEATURES_CACHE_KEY,
          featureCount:
            Array.isArray(activeOldFeaturesCache.data)
              ? activeOldFeaturesCache.data.length
              : 0,

          wiqlCount:
            activeOldFeaturesCache.rangeCount ?? 0,

          lastRefresh:
            Number.isFinite(
              Number(activeOldFeaturesCache.timestamp)
            )
              ? new Date(
                  Number(activeOldFeaturesCache.timestamp)
                ).toISOString()
              : null,

          ageMinutes:
            Number.isFinite(
              Number(activeOldFeaturesCache.timestamp)
            )
              ? Math.round(
                  (
                    now -
                    Number(activeOldFeaturesCache.timestamp)
                  ) / 60000
                )
              : null,

          wasSplit: Boolean(
            activeOldFeaturesCache.rangeDetail?.wasSplit
          ),

          subQueryCount: Number(
            activeOldFeaturesCache.rangeDetail?.subQueryCount || 0
          ),

          complete:
            activeOldFeaturesCache.rangeDetail?.complete !== false,

          usedPreviousCache: usedPreviousActiveOldCache
        },

        /*
          Detalle individual de los shards v2.

          En legacy-fallback no existe información individual confiable,
          porque el caché heredado contiene todos los rangos juntos.
        */
        historicalRanges: usedLegacyFallback
          ? []
          : (oldFeaturesCache.historicalRanges || []).map(range => ({
              ...range,

              /*
                La edad se calcula al responder, no se guarda en Redis.
                Así siempre refleja el momento real de la consulta.
              */
              ageMinutes:
                Number.isFinite(Number(range.timestamp))
                  ? Math.round(
                      (now - Number(range.timestamp)) / 60000
                    )
                  : null
            }))
      },
      features: allFeatures
    });
    
  } catch (error) {
    /* El diagnóstico completo se conserva en logs del servidor para soporte técnico. No debe enviarse al navegador, incluso si no
      contiene explícitamente Authorization o el PAT. */
    const diagnostic = {
      errorName: error.name || 'Error',
      message: error.message || 'Unknown error',
      adoStatus: error.response?.status || null,
      adoStatusText: error.response?.statusText || null,
      adoResponse: error.response?.data || null,
      errorCode: error.code || null,
      stack: error.stack || null
    };

    console.error('ERROR /api/features', diagnostic);

    /* Contrato público seguro: 
      - sin diagnostic;
      - sin detalles de Azure DevOps;
      - sin códigos de red internos;
      - sin stack trace.  */
    return res.status(
      error.statusCode || 500
    ).json({
      error:
        error.statusCode === 503
          ? 'Historical Features could not be fully retrieved from Azure DevOps. Please try again shortly.'
          : 'Unable to fetch Features from Azure DevOps.'
    });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('ok'));
