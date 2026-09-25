FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.pilot-container.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm exec tsc -p tsconfig.pilot-container.json
RUN pnpm prune --prod

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS node-runtime

FROM scratch AS runtime
ENV NODE_ENV=production
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
WORKDIR /app
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /lib/ld-musl-*.so.1 /lib/
COPY --from=node-runtime /usr/lib/libstdc++.so.6 /usr/lib/libstdc++.so.6
COPY --from=node-runtime /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
COPY --from=node-runtime /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/node", "/app/dist/src/product/run-pilot-package.js"]
CMD ["serve", "--root", "/pilot", "--container-internal"]
