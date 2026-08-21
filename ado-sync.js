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

// Protección adicional para evitar solicitudes batch accidentalmente enormes.
// El dashboard actual manda como máximo 15 IDs por página.
const MAX_HISTORY_BATCH_IDS = 500;

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
    baseURL: `https://dev.azure.com/${process.env.ADO_ORG}/${process.env.ADO_PROJECT}/_apis`,
    headers: {
      Authorization: `Basic ${Buffer.from(`:${process.env.ADO_PAT}`).toString('base64')}`,
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
  'Microsoft.VSTS.Scheduling.StoryPoints',
  'System.AssignedTo'
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

  return {
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

  relevantWorkItems.forEach(item => {
    const state = item.state || '';

    // Removed aparece por separado y nunca entra en las categorías
    // de delivery ni en el cálculo de elementos no estimados.
    if (REMOVED_WORK_STATES.includes(state)) {
      removedWorkItems += 1;
      return;
    }

    if (DONE_WORK_STATES.includes(state)) {
      doneWorkItems += 1;
    } else if (IN_PROGRESS_WORK_STATES.includes(state)) {
      inProgressWorkItems += 1;
    } else {
      /*
        Cualquier estado vigente no reconocido explícitamente como Done
        o In progress se considera Pending.
        
        Ejemplos actuales:
        New, Business Refinement, Technical Refinement, Planned,
        Ready for Development, o cualquier nuevo estado futuro.
      */
      pendingWorkItems += 1;
    }

    /*
      Se conserva la política existente de estimación:
      sólo los estados incluidos en ESTIMABLE_WORK_STATES requieren
      Story Points para contar como "unestimated".

      Importante: Removed ya salió del flujo antes de este punto.
    */
    const storyPoints = Number(item.storyPoints) || 0;

    if (
      ESTIMABLE_WORK_STATES.includes(state) &&
      storyPoints <= 0
    ) {
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

// ===== Consulta campos de Stories/Bugs relacionados en lotes de 200 =====
// Evita el patrón de una consulta por Feature.
async function fetchDeliveryWorkItemsBatch(c, ids) {
  const batchSize = 200;
  const workItemsById = new Map();
  const unavailableIds = new Set();

  for (let i = 0; i < ids.length; i += batchSize) {
    const currentIds = ids.slice(i, i + batchSize);

    try {
      const response = await c.post('/wit/workitemsbatch?api-version=7.0', {
        ids: currentIds,
        fields: DELIVERY_WORK_ITEM_FIELDS,
        errorPolicy: 'Omit'
      });

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
          storyPoints:
            fields['Microsoft.VSTS.Scheduling.StoryPoints'] || '',
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

// ===== Trae IDs para un rango de fechas específico =====
async function fetchIdsForRange(c, range) {
  const r = await c.post('/wit/wiql?api-version=7.0', {
    query: `SELECT [System.Id], [System.Title] FROM workitems WHERE [System.WorkItemType] = "Feature" AND [System.ChangedDate] >= ${range.from} AND [System.ChangedDate] < ${range.to} ${BASE_FILTER}`
  });
  return r.data.workItems.map(i => i.id);
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
      c.post('/wit/workitemsbatch?api-version=7.0', {
        ids: currentIds,
        fields: FEATURE_FIELDS,
        errorPolicy: 'Omit'
      }),

      c.post('/wit/workitemsbatch?api-version=7.0', {
        ids: currentIds,
        $expand: 'Relations',
        errorPolicy: 'Omit'
      })
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
    const authHeader = Buffer.from(`:${process.env.ADO_PAT}`).toString('base64');
    
    const c = axios.create({
      baseURL: `https://dev.azure.com/${process.env.ADO_ORG}/${process.env.ADO_PROJECT}/_apis`,
      headers: { 
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/json'
      }
    });

    const featureId = req.params.id;
    console.log('Fetching history for feature:', featureId);
    
    const revisionsResponse = await c.get(`/wit/workitems/${featureId}/revisions?api-version=7.0`);

    const stateChanges = [];
    let previousState = null;

    
    revisionsResponse.data.value.forEach(revision => {
      const currentState = revision.fields['System.State'];
  
      // Solo agregar si el estado cambió o es la primera revisión
      if (currentState && currentState !== previousState) {
        stateChanges.push({
          rev: revision.rev,
          state: currentState,
          changedDate: revision.fields['System.ChangedDate'],
          changedBy: revision.changedBy?.displayName || 'System'
        });
        previousState = currentState;
      }
    });

    res.json({
      id: featureId,
      stateChanges: stateChanges,
      totalRevisions: revisionsResponse.data.value.length
    });
  } catch (error) {
    console.error('Error fetching history:', error.message);
    res.status(500).json({ error: error.message, details: error.response?.data });
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
    const authHeader = Buffer.from(`:${process.env.ADO_PAT}`).toString('base64');
    
    const c = axios.create({
      baseURL: `https://dev.azure.com/${process.env.ADO_ORG}/${process.env.ADO_PROJECT}/_apis`,
      headers: { 
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/json'
      }
    });

    const storyId = req.params.id;
    const revisionsResponse = await c.get(`/wit/workitems/${storyId}/revisions?api-version=7.0`);

    const stateChanges = [];
    let previousState = null;

    revisionsResponse.data.value.forEach(revision => {
      const currentState = revision.fields['System.State'];
      if (currentState && currentState !== previousState) {
        stateChanges.push({
          rev: revision.rev,
          state: currentState,
          changedDate: revision.fields['System.ChangedDate'],
          changedBy: revision.fields['System.ChangedBy']?.displayName || 'System'
        });
        previousState = currentState;
      }
    });

    // 👇 Tomamos el IterationPath de la última revisión (el estado actual)
    const revisions = revisionsResponse.data.value;
    const lastRevision = revisions[revisions.length - 1];
    const iterationPath = lastRevision?.fields['System.IterationPath'] || null;

    res.json({
      id: storyId,
      iterationPath: iterationPath,   // 👈 nuevo campo agregado
      stateChanges: stateChanges,
      totalRevisions: revisions.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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

app.get('/api/feature-stories/:id', async (req, res) => {
  try {
    const c = getAdoClient();
    const featureId = Number(req.params.id);

    if (!Number.isFinite(featureId)) {
      return res.status(400).json({
        error: 'Invalid Feature ID.'
      });
    }

    /* Obtenemos el Feature con sus relaciones directas. 
      Esto evita depender de una consulta WIQL de WorkItemLinks y usa
      exactamente la misma interpretación de hijos directos que Delivery
      Health: Feature -> User Story / Bug. */
    const featureResponse = await c.get(
      `/wit/workitems/${featureId}?$expand=Relations&api-version=7.0`
    );

    const feature = featureResponse.data || {};

    const childIds = getDirectChildWorkItemIds(feature);

    if (childIds.length === 0) {
      return res.json({
        stories: []
      });
    }

    /*
      Azure DevOps workitemsbatch admite hasta 200 IDs por consulta.
      Aunque normalmente un Feature tendrá menos, este código protege
      el endpoint cuando haya una cantidad mayor.
    */
    const batchSize = 200;
    const allWorkItems = [];

    for (let index = 0; index < childIds.length; index += batchSize) {
      const currentIds = childIds.slice(index, index + batchSize);

      const batchResponse = await c.post(
        '/wit/workitemsbatch?api-version=7.0',
        {
          ids: currentIds,
          fields: [
            'System.Id',
            'System.Title',
            'System.State',
            'System.WorkItemType',
            'System.IterationPath',
            'System.AssignedTo',
            'Microsoft.VSTS.Scheduling.StoryPoints'
          ],
          errorPolicy: 'Omit'
        }
      );

      allWorkItems.push(...(batchResponse.data.value || []));
    }

    const stories = allWorkItems
      .filter(workItem => {
        const workItemType =
          workItem.fields?.['System.WorkItemType'] || '';

        return (
          workItemType === 'User Story' ||
          workItemType === 'Bug'
        );
      })
      .map(workItem => {
        const fields = workItem.fields || {};
        const assignedToField = fields['System.AssignedTo'];

        /*
          Normaliza Assigned To porque ADO puede devolver:
          - un objeto IdentityRef con displayName;
          - un texto, según la respuesta o integración.
        */
        const assignedTo =
          typeof assignedToField === 'string'
            ? assignedToField
            : assignedToField?.displayName ||
              assignedToField?.uniqueName ||
              '';

        return {
          id: workItem.id,
          title: fields['System.Title'] || '',
          storyPoints:
            fields['Microsoft.VSTS.Scheduling.StoryPoints'] || 0,
          state: fields['System.State'] || '',
          workItemType: fields['System.WorkItemType'] || '',
          iterationPath: fields['System.IterationPath'] || '',
          assignedTo
        };
      });

    return res.json({
      stories
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
      error: 'Unable to fetch Feature Stories/Bugs from ADO.',
      details: error.response?.data || null
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

    // Diagnóstico temporal para poder identificar el problema cuando
    // los logs de Vercel no están disponibles.
    //
    // No exponer stack, variables de entorno, Authorization ni PAT.
    res.status(500).json({
      error: 'Unable to fetch Features from ADO.',
      diagnostic
    });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('ok'));
