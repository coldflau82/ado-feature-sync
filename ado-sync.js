require('dotenv').config();

const express = require('express');
const axios = require('axios');
const path = require('path');

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
    config.workItemStates?.removed,
    'workItemStates.removed'
  );

  assertNonEmptyStringArray(
    config.workItemStates?.done,
    'workItemStates.done'
  );

  assertNonEmptyStringArray(
    config.workItemStates?.inProgress,
    'workItemStates.inProgress'
  );

  assertNonEmptyStringArray(
    config.workItemStates?.requiresEstimate,
    'workItemStates.requiresEstimate'
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

const OLD_FEATURES_CACHE_TTL_SECONDS = 12 * 60 * 60;
const RECENT_DAYS_THRESHOLD = 10;
const CACHE_KEY = 'oldFeaturesCache';

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

const DONE_WORK_STATES =
  deliveryHealthRules.workItemStates.done;

const IN_PROGRESS_WORK_STATES =
  deliveryHealthRules.workItemStates.inProgress;

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
  Convierte una fecha de ADO a YYYY-MM-DD.

  Para valores como "2026-08-22", conserva exactamente la fecha indicada
  y evita que JavaScript la desplace por diferencias de zona horaria.
*/
function getDateKey(value) {
  if (!value) {
    return null;
  }

  const rawValue = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) {
    return rawValue;
  }

  const parsedDate = new Date(rawValue);

  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  return parsedDate.toISOString().slice(0, 10);
}

function getTodayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysToDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);

  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
}

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

  const today = new Date();
  const nextMonthStart = new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth() + 1,
      1
    )
  );

  const nextMonthEnd = new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth() + 2,
      0
    )
  );

  const nextMonthStartKey = nextMonthStart
    .toISOString()
    .slice(0, 10);

  const nextMonthEndKey = nextMonthEnd
    .toISOString()
    .slice(0, 10);

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
    iterationPath: fields['System.IterationPath'] || '',
    priority: fields['Microsoft.VSTS.Common.Priority'] || '',
    targetDate: fields['Microsoft.VSTS.Scheduling.TargetDate'] || '',
    plannedMonth: fields['Custom.PlannedMonth'] || '',
    releaseFixVersion: fields['Custom.ReleaseFixVersion'] || '',
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

      doneWorkItems: null,
      inProgressWorkItems: null,
      pendingWorkItems: null,
      openWorkItems: null,

      unestimatedWorkItems: null,
      discoveryWithoutSprintWorkItems: null,
      workItemsPendingDelivery: null,

      /*
        Alias de compatibilidad temporal para cualquier consumidor
        existente que aún use los nombres anteriores.
      */
      excludedWorkItems: null,
      completedWorkItems: null,
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
function buildDeliverySummary(workItems, source = 'ok') {
  const unknownSummary = {
    source: 'unknown',
    hasWorkItems: null,

    totalWorkItems: null,
    includedWorkItems: null,
    removedWorkItems: null,

    doneWorkItems: null,
    inProgressWorkItems: null,
    pendingWorkItems: null,
    openWorkItems: null,

    unestimatedWorkItems: null,
    discoveryWithoutSprintWorkItems: null,
    workItemsPendingDelivery: null,
    
    // Alias de compatibilidad temporal.
    excludedWorkItems: null,
    completedWorkItems: null,
    activeWorkItems: null,
    pendingNonActiveWorkItems: null
  };

  if (source !== 'ok') {
    return unknownSummary;
  }

  // Delivery Health considera exclusivamente hijos directos de tipo
  // User Story o Bug.
  const relevantWorkItems = workItems.filter(
    item =>
      item.workItemType === 'User Story' ||
      item.workItemType === 'Bug'
  );

  let removedWorkItems = 0;
  let doneWorkItems = 0;
  let inProgressWorkItems = 0;
  let pendingWorkItems = 0;
  let unestimatedWorkItems = 0;
  let discoveryWithoutSprintWorkItems = 0;

  relevantWorkItems.forEach(item => {
    const state = item.state || '';

    // Removed aparece por separado y nunca entra en las categorías
    // de delivery ni en el cálculo de elementos no estimados.
    if (REMOVED_WORK_STATES.includes(state)) {
      removedWorkItems += 1;
      return;
    }

    let isDiscoveryWork = false;

    if (DONE_WORK_STATES.includes(state)) {
      doneWorkItems += 1;
    } else if (IN_PROGRESS_WORK_STATES.includes(state)) {
      inProgressWorkItems += 1;
    } else {
      /* Cualquier estado vigente que no sea Done ni In progress se considera trabajo en Discovery / pendiente. */
      pendingWorkItems += 1;
      isDiscoveryWork = true;
    }
    
    /* Para esta regla, "sin Sprint" significa que el Work Item no tiene Iteration Path informado. Los elementos Removed ya salieron antes. */
      const hasIterationPath =
      typeof item.iterationPath === 'string' &&
      item.iterationPath.trim().length > 0;
    
    if (isDiscoveryWork && !hasIterationPath) {
      discoveryWithoutSprintWorkItems += 1;
    }
    
    /* Un work item cuenta como "unestimated" únicamente si su estado
      requiere estimación y no tiene puntos válidos o tiene 0 puntos.    
      La misma función se expondrá al frontend mediante isUnestimated,
      para que el detalle gris y Delivery Health siempre coincidan. */
    if (isWorkItemUnestimated(item)) {
      unestimatedWorkItems += 1;
    }
  });

  const includedWorkItems =
    doneWorkItems +
    inProgressWorkItems +
    pendingWorkItems;

  const totalWorkItems = relevantWorkItems.length;

  const openWorkItems =
    inProgressWorkItems +
    pendingWorkItems;

  return {
    source: 'ok',

    hasWorkItems: includedWorkItems > 0,

    // Nuevo modelo unificado.
    totalWorkItems,
    includedWorkItems,
    removedWorkItems,

    doneWorkItems,
    inProgressWorkItems,
    pendingWorkItems,
    openWorkItems,

    unestimatedWorkItems,
    discoveryWithoutSprintWorkItems,

    // Overdue debe depender de trabajo vigente no terminado.
    workItemsPendingDelivery: openWorkItems > 0,

    /*
      Alias de compatibilidad temporal.

      Pueden eliminarse cuando confirmemos que ningún consumidor usa
      los nombres antiguos.
    */
    excludedWorkItems: removedWorkItems,
    completedWorkItems: doneWorkItems,
    activeWorkItems: inProgressWorkItems,
    pendingNonActiveWorkItems: pendingWorkItems
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
  const openWorkItems = Number(summary.openWorkItems || 0);
  const pendingWorkItems = Number(summary.pendingWorkItems || 0);

  const inProgressWorkItems = Number(
    summary.inProgressWorkItems || 0
  );

  const unestimatedWorkItems = Number(
    summary.unestimatedWorkItems || 0
  );

  const discoveryWithoutSprintWorkItems = Number(
    summary.discoveryWithoutSprintWorkItems || 0
  );

  const isClosed = FEATURE_CLOSED_STATES.includes(state);

  const isExecutionState =
    FEATURE_DELIVERY_EXECUTION_STATES.includes(state);

  const isNotStartedState =
    FEATURE_NOT_STARTED_STATES.includes(state);

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
    state === 'In Process' &&
    pendingWorkItems > 0 &&
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
async function enrichFeaturesWithDeliverySummary(c, features) {
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
        deliverySummary: buildDeliverySummary([], 'unknown')
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
        deliverySummary: buildDeliverySummary([], 'unknown')
      };
    }

    const deliveryWorkItems = childIds
      .map(childId => workItemsById.get(childId))
      .filter(Boolean);

    return {
      ...feature,
      deliverySummary: buildDeliverySummary(deliveryWorkItems, 'ok')
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
    /* Estas propiedades ya son utilizadas por el frontend para mostrar el detalle, sin reinterpretar la regla de estimación. */
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

/* Convierte una fecha UTC en un literal compatible con WIQL.
  Ejemplo: 2026-08-28T04:30:00.000Z => '2026-08-28T04:30:00Z'
  Las comillas son necesarias porque el valor se insertará como literal de fecha/hora dentro de la consulta WIQL. */

function formatWiqlDateTime(date) {
  return `'${date.toISOString().replace('.000Z', 'Z')}'`;
}

/* Convierte las expresiones actualmente usadas por el dashboard:
  - @today
  - @today - 10
  - @today + 1
  a un límite UTC concreto, únicamente cuando necesitamos subdividir una consulta que alcanzó el límite de 200 resultados.
  La consulta inicial continúa usando las expresiones actuales de ADO.  Esto minimiza el cambio de comportamiento respecto a producción. */

function getUtcDateFromTodayExpression(expression) {
  const normalizedExpression = String(expression || '')
    .trim()
    .replace(/\s+/g, ' ');

  const todayUtc = new Date();

  todayUtc.setUTCHours(0, 0, 0, 0);

  if (normalizedExpression === '@today') {
    return todayUtc;
  }

  const match = normalizedExpression.match(
    /^@today\s*([+-])\s*(\d+)$/
  );

  if (!match) {
    throw new Error(
      `Unable to split unsupported WIQL date expression: "${expression}".`
    );
  }

  const operator = match[1];
  const days = Number(match[2]);

  if (!Number.isInteger(days)) {
    throw new Error(
      `Unable to parse WIQL date expression: "${expression}".`
    );
  }

  const result = new Date(todayUtc);

  result.setUTCDate(
    result.getUTCDate() + (operator === '+' ? days : -days)
  );

  return result;
}

/* Construye el filtro de ChangedDate.
  Para la consulta inicial usamos los macros existentes de WIQL, por ejemplo: [System.ChangedDate] >= @today - 180
  Para subrangos usamos fechas UTC con precisión de hora/minuto: [System.ChangedDate] >= '2026-02-28T00:00:00Z'
  Así la mitad izquierda usa "< midpoint" y la derecha usa ">= midpoint", sin solapamientos ni huecos. */

function buildChangedDateFilter(range) {
  const fromValue = range.fromDate
    ? formatWiqlDateTime(range.fromDate)
    : range.from;

  const toValue = range.toDate
    ? formatWiqlDateTime(range.toDate)
    : range.to;

  return (
    `[System.ChangedDate] >= ${fromValue} ` +
    `AND [System.ChangedDate] < ${toValue}`
  );
}

/* Devuelve límites Date para un rango.
  Los rangos originales tienen from/to con macros WIQL. Los subrangos generados automáticamente tienen fromDate/toDate. */
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

async function fetchIdsForSingleRange(c, range) {
  const response = await withAdoRetry(() =>
    c.post('/wit/wiql?timePrecision=true&api-version=7.0', {
      query:
        'SELECT [System.Id], [System.Title] ' +
        'FROM workitems ' +
        'WHERE [System.WorkItemType] = "Feature" ' +
        `AND ${buildChangedDateFilter(range)} ` +
        `${BASE_FILTER}`
    })
  );

  return (response.data?.workItems || [])
    .map(item => Number(item.id))
    .filter(Number.isInteger);
}

/* Recupera IDs de Features para un rango de ChangedDate.
  Si ADO devuelve exactamente 200 elementos, el resultado puede estar truncado. En ese caso el rango se divide recursivamente hasta que
  cada subconsulta devuelva menos de 200 elementos.
  La ejecución es secuencial de forma deliberada dentro de la recursión. Ya existe concurrencia controlada entre rangos históricos mediante
  OLD_FEATURES_RANGE_CONCURRENCY; lanzar además ambas mitades en paralelo aumentaría innecesariamente el riesgo de throttling HTTP 429. */

async function fetchIdsForRange(c, range) { const ids = await fetchIdsForSingleRange(c, range);
  if (ids.length < WIQL_SATURATION_LIMIT) { return ids; }
  const { fromDate, toDate } = getRangeDateBounds(range);
  const rangeDurationMs = toDate.getTime() - fromDate.getTime();
  if (rangeDurationMs <= WIQL_MINIMUM_RANGE_MS) {
    throw new Error(
      'WIQL range remained saturated with 200 items even after ' +
      'splitting down to one minute. Data retrieval was stopped to ' +
      'avoid returning an incomplete Feature list.'
    );
  }
  const midpointMs = fromDate.getTime() + Math.floor(rangeDurationMs / 2);
  const midpointDate = new Date(midpointMs);
  /* Protección adicional: el midpoint debe quedar estrictamente entre ambos límites. Si no es posible, la consulta no puede subdividirse de forma segura. */
  if (
    midpointDate <= fromDate ||
    midpointDate >= toDate
  ) {
    throw new Error( 'Unable to create a smaller WIQL range while resolving ' + 'a saturated result set.' );
  }

  console.warn('Splitting saturated WIQL Feature range', {
    originalRange: {
      from: range.from || formatWiqlDateTime(fromDate),
      to: range.to || formatWiqlDateTime(toDate)
    },
    returnedItems: ids.length,
    midpoint: midpointDate.toISOString()
  });

  const leftIds = await fetchIdsForRange(c, { fromDate, toDate: midpointDate });

  const rightIds = await fetchIdsForRange(c, { fromDate: midpointDate, toDate });

  /* La deduplicación es defensiva. Los intervalos no deberían solaparse por diseño, pero evita resultados repetidos si ADO devolviera un ID duplicado inesperadamente.  */
  return [
    ...new Set([
      ...leftIds,
      ...rightIds
    ])
  ];
}

// ===== Trae campos y relaciones de Features en lotes de 200 =====
// Cada verificación conserva la diferencia entre:
// - dato consultado correctamente ("ok")
// - dato que no se pudo obtener ("unknown")
async function fetchFeatureDetailsBatch(c, ids) {
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
        mergedFeatures
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
  const range = { from: `@today - ${RECENT_DAYS_THRESHOLD}`, to: '@today + 1' };
  const rangeCounts = {};
  let ids = [];
  try {
    ids = await fetchIdsForRange(c, range);
    rangeCounts[`${range.from} to ${range.to}`] = ids.length;
  } catch (e) {
    rangeCounts[`${range.from} to ${range.to}`] = 'ERROR: ' + e.message;
  }
  const raw = ids.length ? await fetchFeatureDetailsBatch(c, ids) : [];
  return { features: raw.map(mapFeature), rangeCounts };
}

// ===== Features editadas entre 10 y 180 días (se cachea 12h en el servidor) =====
async function fetchOldFeatures(c) {
  const dateRanges = [
    { from: `@today - 20`, to: `@today - ${RECENT_DAYS_THRESHOLD}` },
    { from: '@today - 30', to: '@today - 20' },
    { from: '@today - 60', to: '@today - 30' },
    { from: '@today - 90', to: '@today - 60' },
    { from: '@today - 180', to: '@today - 90' }
  ];

  /* Ejecuta como máximo dos WIQL en paralelo. Cada rango conserva su propio resultado o error, por lo que un fallo puntual no bloquea
    la creación del caché histórico completo. */
  const rangeResults = await mapWithConcurrency(
    dateRanges,
    OLD_FEATURES_RANGE_CONCURRENCY,
    async range => {
      try {
        const ids = await fetchIdsForRange(c, range);

        return {
          range,
          ids,
          error: null
        };
      } catch (error) {
        return {
          range,
          ids: [],
          error
        };
      }
    }
  );

  const rangeCounts = {};
  const allIds = [];

  /* mapWithConcurrency conserva el mismo orden de dateRanges. Reconstruimos rangeCounts y la lista total de IDs después de que
  terminen las consultas, evitando mutaciones concurrentes sobre allIds o rangeCounts. */
  rangeResults.forEach(({ range, ids, error }) => {
    const rangeKey = `${range.from} to ${range.to}`;

    if (error) {
      rangeCounts[rangeKey] = `ERROR: ${error.message}`;
      return;
    }

    rangeCounts[rangeKey] = ids.length;
    allIds.push(...ids);
  });

  const raw = allIds.length
    ? await fetchFeatureDetailsBatch(c, allIds)
    : [];

  return {
    features: raw.map(mapFeature),
    rangeCounts
  };
}

app.get('/api/health', (req, res) => res.json({ ok: 1 }));

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
    const forceRefresh = req.query.refresh === '1';
    const now = Date.now();

    // 1. Leer el caché "antiguo" desde Redis (persiste entre cold starts e instancias)
    let oldFeaturesCache = await redis.get(CACHE_KEY); // devuelve null si no existe o ya expiró

    const cacheExpired = !oldFeaturesCache;

    if (cacheExpired || forceRefresh) {
      console.log(forceRefresh ? 'Refreshing cache by manual request...' : 'Cache expired, refreshing...');
      const oldResult = await fetchOldFeatures(c);
      oldFeaturesCache = {
        data: oldResult.features,
        rangeCounts: oldResult.rangeCounts,
        timestamp: now
      };
      // Guardamos en Redis con TTL nativo de 12h (en segundos)
      await redis.set(CACHE_KEY, oldFeaturesCache, { ex: OLD_FEATURES_CACHE_TTL_SECONDS });
    }

    // 2. La consulta "reciente" SIEMPRE es en vivo (nunca se cachea)
    const recentResult = await fetchRecentFeatures(c);

    // 3. Deduplicación: si un ID aparece en ambos lados, gana la versión reciente (fresca)
    const recentIds = new Set(recentResult.features.map(f => f.id));
    const cleanOldFeatures = oldFeaturesCache.data.filter(f => !recentIds.has(f.id));

    const allFeatures = [...recentResult.features, ...cleanOldFeatures];

    // 4. rangeCounts y warnings combinados
    const rangeCounts = {
      ...oldFeaturesCache.rangeCounts,
      ...recentResult.rangeCounts
    };

    /* Un conteo mayor o igual a 200 ya no es una advertencia por sí solo:  fetchIdsForRange() divide automáticamente las consultas saturadas.
      Solo se informa al usuario cuando un rango realmente falló y, por tanto, no fue posible confirmar que todos los datos se recuperaron. */
    
    const warnings = Object.entries(rangeCounts)
      .filter(([, count]) =>
        typeof count === 'string' &&
        count.startsWith('ERROR:')
      )
      .map(([range]) =>
        `WARNING: Range "${range}" could not be fully retrieved from Azure DevOps.`
      );

    res.json({
      rangeCounts,
      warnings,
      total: allFeatures.length,
      cacheInfo: {
        lastRefresh: new Date(oldFeaturesCache.timestamp).toISOString(),
        ageMinutes: Math.round(
          (now - oldFeaturesCache.timestamp) / 60000
        )
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
    return res.status(500).json({
      error: 'Unable to fetch Features from Azure DevOps.'
    });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('ok'));
