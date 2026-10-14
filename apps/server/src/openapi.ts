import {
  acceptanceRecordSchema,
  acceptanceRequestSchema,
  agentActionSchema,
  agentSchema,
  apiErrorSchema,
  appSettingsSchema,
  approvalRequestSchema,
  chatMessageSchema,
  checkpointSchema,
  createMessageRequestSchema,
  createProjectRequestSchema,
  createRunRequestSchema,
  deliveryManifestSchema,
  deliverySummarySchema,
  diagnosticsSchema,
  loopDocumentSchema,
  operationAttemptSchema,
  operationReceiptSchema,
  operationRecoveryRequestSchema,
  pageSchema,
  projectSchema,
  providerConfigSchema,
  resolveApprovalRequestSchema,
  runRecoveryRequestSchema,
  runRecoverySummarySchema,
  runActionRequestSchema,
  runConfigSnapshotSchema,
  runEventV2Schema,
  runSchema,
  saveDocumentRequestSchema,
  settingsPatchSchema,
  structuredCommandSchema,
  taskResultSchema,
  taskSpecSchema,
  toolOutputSchema,
  worktreeArtifactSchema
} from '@loop/contracts';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

function jsonSchema(schema: ZodTypeAny) {
  return zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' });
}

const schemas = {
  Error: jsonSchema(apiErrorSchema),
  AgentAction: jsonSchema(agentActionSchema),
  StructuredCommand: jsonSchema(structuredCommandSchema),
  CreateProjectRequest: jsonSchema(createProjectRequestSchema),
  CreateMessageRequest: jsonSchema(createMessageRequestSchema),
  CreateRunRequest: jsonSchema(createRunRequestSchema),
  RunActionRequest: jsonSchema(runActionRequestSchema),
  RunRecoveryRequest: jsonSchema(runRecoveryRequestSchema),
  ResolveApprovalRequest: jsonSchema(resolveApprovalRequestSchema),
  AcceptanceRequest: jsonSchema(acceptanceRequestSchema),
  OperationRecoveryRequest: jsonSchema(operationRecoveryRequestSchema),
  SettingsPatch: jsonSchema(settingsPatchSchema),
  SaveDocumentRequest: jsonSchema(saveDocumentRequestSchema),
  Project: jsonSchema(projectSchema),
  Run: jsonSchema(runSchema),
  RunRecoverySummary: jsonSchema(runRecoverySummarySchema),
  ChatMessage: jsonSchema(chatMessageSchema),
  LoopDocument: jsonSchema(loopDocumentSchema),
  TaskSpec: jsonSchema(taskSpecSchema),
  Agent: jsonSchema(agentSchema),
  Checkpoint: jsonSchema(checkpointSchema),
  ApprovalRequest: jsonSchema(approvalRequestSchema),
  TaskResult: jsonSchema(taskResultSchema),
  ToolOutput: jsonSchema(toolOutputSchema),
  WorktreeArtifact: jsonSchema(worktreeArtifactSchema),
  DeliverySummary: jsonSchema(deliverySummarySchema),
  DeliveryManifest: jsonSchema(deliveryManifestSchema),
  AcceptanceRecord: jsonSchema(acceptanceRecordSchema),
  OperationAttempt: jsonSchema(operationAttemptSchema),
  OperationReceipt: jsonSchema(operationReceiptSchema(operationAttemptSchema)),
  RunConfigSnapshot: jsonSchema(runConfigSnapshotSchema),
  RunEventV2: jsonSchema(runEventV2Schema),
  ProviderConfig: jsonSchema(providerConfigSchema),
  AppSettings: jsonSchema(appSettingsSchema),
  Diagnostics: jsonSchema(diagnosticsSchema),
  PageProject: jsonSchema(pageSchema(projectSchema)),
  PageRun: jsonSchema(pageSchema(runSchema)),
  PageChatMessage: jsonSchema(pageSchema(chatMessageSchema)),
  PageLoopDocument: jsonSchema(pageSchema(loopDocumentSchema)),
  PageTaskSpec: jsonSchema(pageSchema(taskSpecSchema)),
  PageAgent: jsonSchema(pageSchema(agentSchema)),
  PageCheckpoint: jsonSchema(pageSchema(checkpointSchema)),
  PageApprovalRequest: jsonSchema(pageSchema(approvalRequestSchema)),
  PageProviderConfig: jsonSchema(pageSchema(providerConfigSchema)),
  PageOperationAttempt: jsonSchema(pageSchema(operationAttemptSchema)),
  PageDeliveryManifest: jsonSchema(pageSchema(deliveryManifestSchema)),
  PageAcceptanceRecord: jsonSchema(pageSchema(acceptanceRecordSchema))
} as const;

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Loop Local API',
    version: '0.2.0-alpha.1',
    description: '本机单用户、文档驱动的 Agent 工作台 API。REST 与 SSE 使用契约 schema version 2。'
  },
  servers: [{ url: '/api' }],
  paths: {
    '/bootstrap': { get: { operationId: 'bootstrap', responses: successDescription('有界启动快照、分页信息与事件水位') } },
    '/projects': {
      get: { operationId: 'listProjects', parameters: cursorParameters(), responses: entityResponse('PageProject') },
      post: mutation('createProject', 'CreateProjectRequest', 'Project')
    },
    '/runs': {
      get: { operationId: 'listRuns', parameters: cursorParameters(), responses: entityResponse('PageRun') },
      post: mutation('createRun', 'CreateRunRequest', 'Run')
    },
    '/runs/{id}': {
      get: { operationId: 'getRun', parameters: idParameter(), responses: entityResponse('Run') },
      patch: mutation('changeRunState', 'RunActionRequest', 'Run', idParameter())
    },
    '/runs/{id}/recovery': {
      get: readEntity('getRunRecovery', 'RunRecoverySummary'),
      post: mutation('recoverRun', 'RunRecoveryRequest', 'RunRecoverySummary', idParameter())
    },
    '/runs/{id}/messages': {
      get: readCollection('listMessages', 'PageChatMessage'),
      post: mutation('createMessage', 'CreateMessageRequest', 'ChatMessage', idParameter())
    },
    '/runs/{id}/docs': {
      get: readCollection('listDocuments', 'PageLoopDocument'),
      patch: mutation('saveDocument', 'SaveDocumentRequest', 'LoopDocument', idParameter())
    },
    '/runs/{id}/docs/{docId}': {
      get: {
        operationId: 'getDocument',
        parameters: [...idParameter(), stringPathParameter('docId')],
        responses: entityResponse('LoopDocument')
      },
      patch: mutation(
        'saveDocumentById',
        'SaveDocumentRequest',
        'LoopDocument',
        [...idParameter(), stringPathParameter('docId')]
      )
    },
    '/runs/{id}/tasks': { get: readCollection('listTasks', 'PageTaskSpec') },
    '/runs/{id}/agents': { get: readCollection('listAgents', 'PageAgent') },
    '/runs/{id}/checkpoints': { get: readCollection('listCheckpoints', 'PageCheckpoint') },
    '/runs/{id}/approvals': {
      get: readCollection('listApprovals', 'PageApprovalRequest'),
      post: mutation('resolveApproval', 'ResolveApprovalRequest', 'ApprovalRequest', idParameter())
    },
    '/runs/{id}/execute': { post: mutationWithoutBody('executeRun', 'Run', idParameter()) },
    '/runs/{id}/delivery': { get: readEntity('getDeliverySummary', 'DeliverySummary') },
    '/runs/{id}/deliveries': { get: readCollection('listDeliveries', 'PageDeliveryManifest') },
    '/runs/{id}/deliveries/{revision}': {
      get: {
        operationId: 'getDeliveryManifest',
        parameters: [...idParameter(), stringPathParameter('revision')],
        responses: entityResponse('DeliveryManifest')
      }
    },
    '/runs/{id}/acceptances': { get: readCollection('listAcceptances', 'PageAcceptanceRecord') },
    '/runs/{id}/acceptance': {
      post: mutation('acceptDelivery', 'AcceptanceRequest', 'AcceptanceRecord', idParameter())
    },
    '/runs/{id}/tool-outputs/{outputId}': {
      get: {
        operationId: 'getToolOutput',
        parameters: [...idParameter(), stringPathParameter('outputId')],
        responses: entityResponse('ToolOutput')
      }
    },
    '/runs/{id}/events': {
      get: {
        operationId: 'streamRunEvents',
        parameters: [...idParameter(), { name: 'after', in: 'query', schema: { type: 'integer', minimum: 0 } }],
        responses: successDescription('text/event-stream；支持 Last-Event-ID、after、显式 reset/resync')
      }
    },
    '/operations/{id}': { get: readEntity('getOperation', 'OperationAttempt') },
    '/operations/{id}/recovery': {
      post: mutation('recoverOperation', 'OperationRecoveryRequest', 'OperationReceipt', idParameter())
    },
    '/providers': {
      get: { operationId: 'listProviders', parameters: cursorParameters(), responses: entityResponse('PageProviderConfig') }
    },
    '/providers/{id}/test': {
      post: mutationWithoutBody('testProvider', 'ProviderConfig', idParameter())
    },
    '/providers/{id}/models': {
      get: { operationId: 'listProviderModels', parameters: idParameter(), responses: successDescription('供应商模型列表') }
    },
    '/settings': {
      get: { operationId: 'getSettings', responses: entityResponse('AppSettings') },
      patch: mutation('updateSettings', 'SettingsPatch', 'AppSettings')
    },
    '/diagnostics': { get: { operationId: 'getDiagnostics', responses: entityResponse('Diagnostics') } }
  },
  components: { schemas },
  'x-contract-source': '@loop/contracts'
} as const;

function cursorParameters() {
  return [
    { name: 'cursor', in: 'query', schema: { type: 'string' } },
    { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } }
  ];
}

function idParameter() {
  return [stringPathParameter('id')];
}

function stringPathParameter(name: string) {
  return { name, in: 'path', required: true, schema: { type: 'string' } };
}

function idempotencyParameter() {
  return { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1, maxLength: 200 } };
}

function errorResponses() {
  return {
    '4XX': { description: '请求错误', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    '5XX': { description: '服务器错误', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
  };
}

function entityResponse(schema: keyof typeof schemas) {
  return {
    '200': { description: '成功', content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } } },
    ...errorResponses()
  };
}

function successDescription(description: string) {
  return { '200': { description }, ...errorResponses() };
}

function requestBody(schema: keyof typeof schemas) {
  return {
    required: true,
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } }
  };
}

function mutation(
  operationId: string,
  bodySchema: keyof typeof schemas,
  responseSchema: keyof typeof schemas,
  parameters: object[] = []
) {
  return {
    operationId,
    parameters: [...parameters, idempotencyParameter()],
    requestBody: requestBody(bodySchema),
    responses: entityResponse(responseSchema)
  };
}

function mutationWithoutBody(operationId: string, responseSchema: keyof typeof schemas, parameters: object[] = []) {
  return {
    operationId,
    parameters: [...parameters, idempotencyParameter()],
    responses: entityResponse(responseSchema)
  };
}

function readCollection(operationId: string, schema: keyof typeof schemas) {
  return {
    operationId,
    parameters: [...idParameter(), ...cursorParameters()],
    responses: entityResponse(schema)
  };
}

function readEntity(operationId: string, schema: keyof typeof schemas) {
  return { operationId, parameters: idParameter(), responses: entityResponse(schema) };
}
