// Port of backend/app/api/v1/agent_routes.py.
//
// Reserved exclusively for the autonomous agent runtime. The user-initiated
// "Scan Page" button uses POST /security/check-webpage — that workflow is
// entirely separate and unaffected by changes here.
//
// Security scanning has been removed from the agent execution path to
// eliminate the latency overhead of the DL classifier on every iteration.
// Users can still manually scan any page via the toolbar "Scan Page" button.
import type { FastifyInstance } from 'fastify'
import { settings } from '../config/env.js'
import { agentPlannerService } from '../services/agentPlannerService.js'
import { ToolValidationError, allTools, requiresApproval } from '../services/agentToolRegistry.js'
import {
  AgentPlanRequestSchema,
  AgentPlanResponseSchema,
  type AgentPlanRequest,
  type AgentProgressItem,
} from '../schemas/agent.schemas.js'
import { ErrorResponseSchema } from '../schemas/common.js'

export default async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: AgentPlanRequest }>(
    '/agent/plan',
    {
      schema: {
        body: AgentPlanRequestSchema,
        response: {
          200: AgentPlanResponseSchema,
          400: ErrorResponseSchema,
          422: ErrorResponseSchema,
          502: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const goal = request.body.goal.trim()
      if (!goal) {
        return reply.code(400).send({ detail: 'Agent goal cannot be empty.' })
      }

      if (!agentPlannerService.isConfigured) {
        // A placeholder plan would be a fabricated instruction to drive a real
        // browser, so refuse outright rather than inventing an action.
        return reply.code(503).send({
          detail:
            'Agent planner unavailable: no LLM provider is active. ' +
            'Connect and activate a provider in Settings to enable autonomous planning.',
        })
      }

      const memory = request.body.working_memory ?? {}
      const pageState = request.body.page_state ?? {}

      let actions: Array<[string, Record<string, unknown>]>
      let confidence: number
      let reason: string
      let thought: string | undefined
      let progress: AgentProgressItem[] | undefined
      try {
        ;[actions, confidence, reason, thought, progress] = await agentPlannerService.requestPlan(goal, memory, pageState)
      } catch (exc) {
        if (exc instanceof ToolValidationError) {
          // The model produced something we will not execute. Surfaced as 422
          // so the runtime can retry or replan rather than treating it as an outage.
          app.log.warn(`Planner produced an invalid tool call: ${exc.message}`)
          return reply.code(422).send({ detail: `Planner produced an invalid tool call: ${exc.message}` })
        }
        const message = exc instanceof Error ? exc.message : String(exc)
        app.log.warn(`Planner LLM execution error: ${message}`)
        return reply.code(502).send({ detail: `Planner LLM provider error: ${message}` })
      }

      const toolCalls = actions.map(([name, args]) => ({
        tool: name,
        arguments: args,
        requires_approval: requiresApproval(name),
      }))

      return {
        tool_calls: toolCalls,
        tool_call: toolCalls[0]!,
        confidence,
        needs_user_confirmation: confidence < settings.AGENT_MIN_CONFIDENCE,
        reason,
        thought,
        progress,
        model: agentPlannerService.model,
        planner_mode: 'llm' as const,
      }
    },
  )

  // Introspection for the UI: what the planner is currently allowed to do.
  app.get('/agent/tools', async () =>
    allTools().map((spec) => ({
      name: spec.name,
      description: spec.description,
      category: spec.category,
      requires_approval: spec.requiresApproval,
      handled_by_loop: spec.handledByLoop,
      parameters: spec.parameters.map((p) => ({
        name: p.name,
        kind: p.kind,
        required: p.required,
        description: p.description,
      })),
    })),
  )
}
