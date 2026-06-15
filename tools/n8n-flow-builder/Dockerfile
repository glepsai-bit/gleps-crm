# GoodLeads Flow Builder — static site servido por nginx:alpine.
# Build no EasyPanel: criar app "Dockerfile", apontar Build Path para tools/n8n-flow-builder.
FROM nginx:alpine

# Substitui o default.conf por um customizado (CSP, HSTS, gzip, cache de assets)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copia o site estatico
COPY index.html /usr/share/nginx/html/index.html
COPY styles.css /usr/share/nginx/html/styles.css
COPY app.js     /usr/share/nginx/html/app.js
COPY template.js /usr/share/nginx/html/template.js
COPY prompts/   /usr/share/nginx/html/prompts/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost/health || exit 1
