/**
 * Placeholder registrar for B3 MCP gateway admin side (GET /v1/admin/mcp-calls.json); the seat-facing POST /v1/mcp/:id is dispatched from index.ts. Registered once from routes/index.ts so the feature owner fills
 * this module in with defineRoute calls without touching the shared registry.
 */
export function registerMcpGatewayRoutes(): void {
  // Intentionally empty until the feature lands.
}
