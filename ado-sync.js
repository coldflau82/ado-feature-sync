require('dotenv').config();
const express = require('express');
const axios = require('axios');

const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard-app.html'));
});

app.get('/favicon.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'favicon.png'));
});

const { Redis } = require('@upstash/redis');

// Cliente Redis (lee automáticamente las env vars si se llaman KV_REST_API_URL / KV_REST_API_TOKEN)
const redis = Redis.fromEnv();
// Si tus variables tienen otro nombre, usa:
// const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

// ===== Historiales ADO: protección contra throttling =====
// Máximo de consultas simultáneas a /revisions dentro de una solicitud batch.
// Empieza con 5; puede subirse gradualmente si ADO no devuelve 429.
const HISTORY_BATCH_CONCURRENCY = 5;

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

/* Reintenta únicamente errores temporales de Azure DevOps:
  - 429: throttling
  - 502, 503, 504: errores temporales de gateway/servicio
  Si ADO incluye Retry-After, se respeta. Si no, usa backoff exponencial:
  1 s, 2 s y 4 s. */
async function withAdoRetry(operation, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const retryable = [429, 502, 503, 504].includes(status);
      if (!retryable || attempt === maxRetries) {
        throw error;
      }
      const retryAfterHeader = error.response?.headers?.['retry-after'];
      const retryAfterSeconds = Number(retryAfterHeader);
      const waitMs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1000
          : 1000 * (2 ** attempt);
      console.warn('Retrying Azure DevOps request', {
        status,
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

// ===== Cliente ADO reutilizable =====
function getAdoClient() {
  return axios.create({
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
}

// ===== Filtro base de Area Path (idéntico al que ya tenías) =====
const BASE_FILTER = 'AND [System.State] <> "Removed" AND ([System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Online" OR [System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Print" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Cart and Checkout" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 1" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 2" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 3")';

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

// ===== Campos mínimos de Stories/Bugs para Delivery Health =====
// Solo se consultan para construir conteos y banderas.
// No se devuelven títulos, descripciones ni contenido sensible dentro
// del deliverySummary de /api/features.
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
  'System.IterationPath',
  'System.AssignedTo',
  'Microsoft.VSTS.Scheduling.StoryPoints'
];

// ===== Estados de Delivery Health =====
//
// Las categorías deben ser mutuamente excluyentes:
//
// Included in delivery = Done + In progress + Pending
// Total work items = Included in delivery + Removed
//
// Cualquier Story/Bug que no sea Removed, Done o In progress se
// clasifica automáticamente como Pending. Esto evita elementos vigentes
// sin categoría cuando aparezcan nuevos estados en Azure DevOps.

const REMOVED_WORK_STATES = [
  'Removed'
];

const DONE_WORK_STATES = [
  'Approved for Release',
  'Ready for Deployment',
  'Closed'
];

const IN_PROGRESS_WORK_STATES = [
  'In Process',
  'QA Testing',
  'Business Sprint Testing',
  'Sprint Complete',
  'User Acceptance Testing'  
];

// Estados donde una Story o Bug debe contar con Story Points.
// Closed y Removed se excluye: no deben generar un riesgo actual de estimación si ya se completaron.
const ESTIMABLE_WORK_STATES = [
  'Planned',
  'Ready for Development',
  'In Process',
  'QA Testing',
  'Business Sprint Testing',
  'User Acceptance Testing',
  'Approved for Release',
  'Ready for Deployment',
  'Sprint Complete'
];

// ===== Estados del Feature usados por Delivery Health =====
// Estas reglas antes vivían únicamente en el frontend.
// Ahora el backend será la fuente de verdad.

const FEATURE_DELIVERY_EXECUTION_STATES = [
  'Planned',
  'In Process'
];

const FEATURE_CLOSED_STATES = [
  'Closed'
];

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

function isTargetDateWithinNextTwoWeeks(targetDate) {
  const targetDateKey = getDateKey(targetDate);

  if (!targetDateKey) {
    return false;
  }

  const todayDateKey = getTodayDateKey();
  const twoWeeksDateKey = addDaysToDateKey(todayDateKey, 14);

  return (
    targetDateKey >= todayDateKey &&
    targetDateKey <= twoWeeksDateKey
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

// ===== Crea un resumen unificado de Stories/Bugs para Delivery Health =====
//
// Reglas:
//
// totalWorkItems = includedWorkItems + removedWorkItems
// includedWorkItems = doneWorkItems + inProgressWorkItems + pendingWorkItems
// openWorkItems = inProgressWorkItems + pendingWorkItems
//
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
// las reglas de negocio. Los alertas son acumulables: un Feature puede
// tener más de una condición que requiera seguimiento.

function buildDeliveryHealth(feature) {
  const summary = feature.deliverySummary;
  const state = String(feature.state || '').trim();

  const unknownResult = {
    primary: {
      key: 'unable-to-evaluate',
      label: 'Unable to evaluate',
      shortLabel: 'Unavailable',
      group: 'requires-attention',
      reason: 'Delivery work information could not be retrieved.'
    },
    alerts: [
      {
        key: 'unable-to-evaluate',
        label: 'Unable to evaluate',
        group: 'requires-attention',
        reason: 'Delivery work information could not be retrieved.'
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

  /*
    Not started es informativo: no entra en Requires Action,
    Requires Attention ni Healthy. No representa una alerta.
  */
  if (
    state === 'New' &&
    !summary.hasWorkItems &&
    totalWorkItems === 0
  ) {
    return {
      primary: {
        key: 'not-started',
        label: 'Not started',
        shortLabel: 'Not started',
        group: 'not-started',
        reason:
          'This Feature is New and does not have associated Stories or Bugs yet.'
      },
      alerts: []
    };
  }

  const alerts = [];

  // Prioridad 1: Target Date vencido con trabajo aún abierto.
  if (isPastTargetDate(feature.targetDate) && openWorkItems > 0) {
    alerts.push({
      key: 'overdue',
      label: 'Overdue',
      group: 'requires-action',
      reason:
        'The Target Date has passed and delivery work remains open.'
    });
  }

  // Prioridad 2: Target Date muy cercana con trabajo Discovery sin Sprint.
  if (
    isTargetDateWithinNextTwoWeeks(feature.targetDate) &&
    discoveryWithoutSprintWorkItems > 0
  ) {
    alerts.push({
      key: 'target-date-near-unscheduled-discovery',
      label: 'Target date near',
      group: 'requires-action',
      reason:
        `${discoveryWithoutSprintWorkItems} Discovery work item(s) are not assigned to a Sprint, and the Target Date is within the next two weeks.`
    });
  }

  // Prioridad 3: Fecha en el siguiente mes y sin Release Fix Version.
  if (
    isTargetDateInNextCalendarMonth(feature.targetDate) &&
    !String(feature.releaseFixVersion || '').trim()
  ) {
    alerts.push({
      key: 'target-next-month-without-release',
      label: 'Target date next month — no Release Fix Version',
      group: 'requires-action',
      reason:
        'The Target Date falls in the next calendar month, but no Release Fix Version is defined.'
    });
  }

  if (isClosed && openWorkItems > 0) {
    alerts.push({
      key: 'closed-with-open-work',
      label: 'Open work on Closed Feature',
      group: 'requires-attention',
      reason:
        'The Feature is Closed, but associated delivery work is still open or in progress.'
    });
  }

  /*
    Los controles de estimación y ejecución se aplican únicamente
    desde Planned e In Process. Esto evita marcar Features tempranos
    como riesgosos cuando todavía están en Shaping o Planning.
  */
  if (isExecutionState && !hasFeatureEstimate(feature)) {
    alerts.push({
      key: 'needs-estimate',
      label: 'Needs estimate',
      group: 'requires-attention',
      reason:
        'The Feature is Planned or In Process and does not have BE, FE, or QA estimates.'
    });
  }

  if (
    isExecutionState &&
    (!summary.hasWorkItems || totalWorkItems === 0)
  ) {
    alerts.push({
      key: 'no-stories',
      label: 'No Stories',
      group: 'requires-attention',
      reason:
        'This Feature is in delivery execution but has no associated Stories or Bugs.'
    });
  }

  if (
    state === 'In Process' &&
    pendingWorkItems > 0 &&
    inProgressWorkItems === 0
  ) {
    alerts.push({
      key: 'no-active-work',
      label: 'No active work',
      group: 'requires-attention',
      reason:
        'There is open delivery work, but no Story or Bug is currently active.'
    });
  }

  if (isExecutionState && unestimatedWorkItems > 0) {
    alerts.push({
      key: 'unestimated-work',
      label: 'No estimated work',
      group: 'requires-attention',
      reason:
        `${unestimatedWorkItems} associated work item(s) do not have an estimate.`
    });
  }

  /*
    Si no hay alertas, el Feature está saludable. Esto incluye:
    - Closed sin trabajo abierto.
    - Estados anteriores a Planned.
    - Features en ejecución sin riesgos detectados.
  */
  if (alerts.length === 0) {
    return {
      primary: {
        key: 'healthy',
        label: 'Healthy',
        shortLabel: 'Healthy',
        group: 'healthy',
        reason: 'No delivery execution risks were detected.'
      },
      alerts: []
    };
  }

  const primaryAlert = alerts[0];

  return {
    primary: {
      ...primaryAlert,
      shortLabel:
        primaryAlert.key === 'target-date-near-unscheduled-discovery' ||
        primaryAlert.key === 'target-next-month-without-release'
          ? 'At risk'
          : primaryAlert.label
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
    iterationPath: fields['System.IterationPath'] || '',
    assignedTo,

    /*
      Estas propiedades ya son utilizadas por el frontend para mostrar
      el detalle, sin reinterpretar la regla de estimación.
    */
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

/*
  Carga Stories/Bugs de varios Features en una única operación lógica.

  Flujo:
  1. Obtiene relaciones directas de todos los Features solicitados.
  2. Extrae IDs hijos únicos.
  3. Obtiene campos de todos los hijos en batches de máximo 200.
  4. Reconstruye el resultado agrupado por Feature.

  El resultado no considera como error que un Feature tenga cero hijos.
  En cambio, sí declara unavailable si ADO no permitió recuperar los
  datos necesarios para determinar el resultado real.
*/
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

  /*
    Para IDs no disponibles se conserva results[id]: [] por consistencia
    estructural, pero el frontend debe usar unavailableFeatureIds para no
    confundir este caso con "sin Stories/Bugs".
  */
  return {
    results,
    unavailableFeatureIds: [...unavailableFeatureIds]
  };
}

// ===== Trae IDs para un rango de fechas específico =====
async function fetchIdsForRange(c, range) {
  const response = await withAdoRetry(() =>
    c.post('/wit/wiql?api-version=7.0', {
      query: `SELECT [System.Id], [System.Title] FROM workitems WHERE [System.WorkItemType] = "Feature" AND [System.ChangedDate] >= ${range.from} AND [System.ChangedDate] < ${range.to} ${BASE_FILTER}`
    })
  );

  return response.data.workItems.map(item => item.id);
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

  let allIds = [];
  const rangeCounts = {};

  for (const range of dateRanges) {
    try {
      const ids = await fetchIdsForRange(c, range);
      rangeCounts[`${range.from} to ${range.to}`] = ids.length;
      allIds = [...allIds, ...ids];
    } catch (e) {
      rangeCounts[`${range.from} to ${range.to}`] = 'ERROR: ' + e.message;
    }
  }

  const raw = allIds.length ? await fetchFeatureDetailsBatch(c, allIds) : [];
  return { features: raw.map(mapFeature), rangeCounts };
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
      message: error.message
    });

    return res.status(500).json({
      error: 'Unable to fetch Feature history from ADO.',
      details: error.response?.data || null
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
      message: error.message
    });

    return res.status(500).json({
      error: 'Unable to fetch Story history from ADO.',
      details: error.response?.data || null
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
    const rangeCounts = { ...oldFeaturesCache.rangeCounts, ...recentResult.rangeCounts };
    const warnings = [];
    for (const [range, count] of Object.entries(rangeCounts)) {
      if (typeof count === 'number' && count >= 200) {
        warnings.push(`WARNING: Range "${range}" has ${count} items - DATA MAY BE MISSING`);
      }
    }

    res.json({
      rangeCounts,
      warnings,
      total: allFeatures.length,
      cacheInfo: {
        lastRefresh: new Date(oldFeaturesCache.timestamp).toISOString(),
        ageMinutes: Math.round((now - oldFeaturesCache.timestamp) / 60000)
      },
      features: allFeatures
    });

    } catch (error) {
    const diagnostic = {
      errorName: error.name || 'Error',
      message: error.message || 'Unknown error',
      adoStatus: error.response?.status || null,
      adoStatusText: error.response?.statusText || null,
      adoResponse: error.response?.data || null,
      errorCode: error.code || null
    };

    console.error('ERROR /api/features', diagnostic);

    // Diagnóstico temporal para poder identificar el problema cuando los logs de Vercel no están disponibles.
    // No exponer stack, variables de entorno, Authorization ni PAT.
    res.status(500).json({
      error: 'Unable to fetch Features from ADO.',
      diagnostic
    });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('ok'));
