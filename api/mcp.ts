import { createMcpHandler } from '@vercel/mcp-adapter';
import { Hono } from 'hono';
import { getToolsFromOpenApi, McpToolDefinition } from 'openapi-mcp-generator/dist/api.js';
import { z } from 'zod';

export const runtime = 'nodejs'

const getTools = async (agentId: string) => {
    const openApiTools = await getToolsFromOpenApi(`https://${agentId}/.well-known/ai-plugin.json`, {
        baseUrl: `https://${agentId}`,
    });

    return openApiTools;
}

const createHandler = async (args: any) => {
    console.log("Creating handler with args:", args);
    const tools = await getTools(args.agentId);
    const baseUrl = `https://${args.agentId}`;
    const originalHeaders = args.originalHeaders || {};

    return createMcpHandler(async (server) => {
        console.log("MCP server initializing...");

        tools.forEach((tool: McpToolDefinition) => {
            const {
                name,
                description,
                inputSchema,
                method,
                pathTemplate,
                parameters,
                executionParameters,
                requestBodyContentType,
                securityRequirements,
                operationId
            } = tool

            console.log('Input schema:', inputSchema);

            // Convert JSON schema properties to Zod schema shape
            const schemaShape: Record<string, z.ZodTypeAny> = {};

            if (inputSchema && typeof inputSchema === 'object' && 'properties' in inputSchema) {
                const properties = inputSchema.properties as Record<string, any>;
                const required = (inputSchema.required as string[]) || [];

                Object.entries(properties).forEach(([key, prop]) => {
                    if (typeof prop === 'object' && prop.type === 'string') {
                        let zodField = z.string();
                        if (prop.description) {
                            zodField = zodField.describe(prop.description);
                        }
                        if (!required.includes(key)) {
                            schemaShape[key] = zodField.optional();
                        } else {
                            schemaShape[key] = zodField;
                        }
                    }
                    // Add more type handling as needed
                });
            }


            console.log('Schema shape:', schemaShape);

            server.tool(name, description, schemaShape, async (params: any) => {
                try {
                    console.log(`Executing tool ${name} with params:`, params);
                    
                    // Construct the URL from pathTemplate and parameters
                    let url = pathTemplate;
                    const queryParams = new URLSearchParams();
                    let requestBody: any = null;
                    const headers: Record<string, string> = {};

                    // Start with original headers, filtering out headers that shouldn't be forwarded
                    const headersToSkip = new Set(['host', 'content-length', 'connection', 'upgrade', 'expect']);
                    Object.entries(originalHeaders).forEach(([key, value]) => {
                        const lowerKey = key.toLowerCase();
                        if (!headersToSkip.has(lowerKey) && typeof value === 'string') {
                            headers[key] = value;
                        }
                    });

                    // Set content type if specified (this will override the original content-type if needed)
                    if (requestBodyContentType) {
                        headers['Content-Type'] = requestBodyContentType;
                    }

                    // Process parameters based on their location
                    if (parameters && Array.isArray(parameters)) {
                        parameters.forEach((param: any) => {
                            const value = params[param.name];
                            if (value !== undefined) {
                                switch (param.in) {
                                    case 'path':
                                        // Replace path parameters in the URL template
                                        url = url.replace(`{${param.name}}`, encodeURIComponent(value));
                                        break;
                                    case 'query':
                                        // Add to query parameters
                                        queryParams.append(param.name, value);
                                        break;
                                    case 'header':
                                        // Add to headers (this will override original headers if same key)
                                        headers[param.name] = value;
                                        break;
                                }
                            }
                        });
                    }

                    // Handle request body for POST/PUT/PATCH requests
                    if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
                        // For these methods, put remaining parameters in the body
                        const bodyParams: Record<string, any> = {};
                        Object.entries(params).forEach(([key, value]) => {
                            // Only include if not already used in path/query/header
                            const isPathParam = parameters?.some((p: any) => p.name === key && p.in === 'path');
                            const isQueryParam = parameters?.some((p: any) => p.name === key && p.in === 'query');
                            const isHeaderParam = parameters?.some((p: any) => p.name === key && p.in === 'header');
                            
                            if (!isPathParam && !isQueryParam && !isHeaderParam) {
                                bodyParams[key] = value;
                            }
                        });
                        
                        if (Object.keys(bodyParams).length > 0) {
                            if (requestBodyContentType?.includes('application/json')) {
                                requestBody = JSON.stringify(bodyParams);
                            } else {
                                // For form data or other content types
                                const formData = new URLSearchParams();
                                Object.entries(bodyParams).forEach(([key, value]) => {
                                    if (value !== undefined) {
                                        formData.append(key, String(value));
                                    }
                                });
                                requestBody = formData.toString();
                            }
                        }
                    }

                    // Construct final URL with query parameters
                    const finalUrl = new URL(url, baseUrl);
                    queryParams.forEach((value, key) => {
                        finalUrl.searchParams.append(key, value);
                    });

                    console.log(`Making ${method} request to:`, finalUrl.toString());
                    console.log('Headers:', headers);
                    console.log('Body:', requestBody);

                    // Make the HTTP request
                    const response = await fetch(finalUrl.toString(), {
                        method: method.toUpperCase(),
                        headers,
                        body: requestBody,
                    });

                    const responseText = await response.text();
                    let responseData;
                    
                    try {
                        responseData = JSON.parse(responseText);
                    } catch {
                        responseData = responseText;
                    }

                    console.log(`Response status: ${response.status}`);
                    console.log(`Response data:`, responseData);

                    if (!response.ok) {
                        return {
                            content: [{ 
                                type: "text", 
                                text: `HTTP Error ${response.status}: ${responseText}` 
                            }],
                            isError: true,
                        };
                    }

                    return {
                        content: [{ 
                            type: "text", 
                            text: JSON.stringify(responseData, null, 2)
                        }],
                    };

                } catch (error) {
                    console.error(`Error executing tool ${name}:`, error);
                    return {
                        content: [{ 
                            type: "text", 
                            text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` 
                        }],
                        isError: true,
                    };
                }
            });
        });

        console.log("MCP server initialized");
    });
}
// Create Hono app for request inspection and logging
const app = new Hono();

// Add logging middleware
app.use('*', async (c, next) => {
    const start = Date.now();
    const method = c.req.method;
    const url = c.req.url;
    const userAgent = c.req.header('user-agent') || 'unknown';
    const contentType = c.req.header('content-type') || 'unknown';

    console.log(`[${new Date().toISOString()}] Incoming ${method} request to ${url}`);
    console.log(`  User-Agent: ${userAgent}`);
    console.log(`  Content-Type: ${contentType}`);

    // Log request headers
    console.log('  Headers:', Object.fromEntries(c.req.raw.headers.entries()));

    await next();

    const duration = Date.now() - start;
    const status = c.res.status;

    console.log(`[${new Date().toISOString()}] ${method} ${url} - ${status} (${duration}ms)`);
});

// Wrap each HTTP method with Hono handlers
app.get('*', async (c) => {
    console.log('Handling GET request through MCP handler');
    const params = c.req.query();
    const agentId = params.agentId;

    // Extract original headers
    const originalHeaders = Object.fromEntries(c.req.raw.headers.entries());

    const handler = await createHandler({ 
        agentId: agentId,
        originalHeaders: originalHeaders
    });
    return handler(c.req.raw);
});

app.post('*', async (c) => {
    console.log('Handling POST request through MCP handler');
    const params = c.req.query();
    const agentId = params.agentId;

    // Extract original headers
    const originalHeaders = Object.fromEntries(c.req.raw.headers.entries());

    const handler = await createHandler({ 
        agentId: agentId,
        originalHeaders: originalHeaders
    });
    return handler(c.req.raw);
});

app.delete('*', async (c) => {
    console.log('Handling DELETE request through MCP handler');
    const params = c.req.query();
    const agentId = params.agentId;

    // Extract original headers
    const originalHeaders = Object.fromEntries(c.req.raw.headers.entries());

    const handler = await createHandler({ 
        agentId: agentId,
        originalHeaders: originalHeaders
    });
    return handler(c.req.raw);
});

// Export Hono handlers
export const GET = app.fetch;
export const POST = app.fetch;
export const DELETE = app.fetch;
