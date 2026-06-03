FROM node:20-alpine

WORKDIR /app

# Install mcp-pager from npm (published package)
RUN npm init -y && \
    npm install mcp-pager @modelcontextprotocol/sdk zod

# Copy the standalone server entry point
COPY server.mjs ./

# Run the demo server via stdio (standard MCP transport)
CMD ["node", "server.mjs"]
