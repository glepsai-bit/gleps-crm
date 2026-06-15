FROM nginx:alpine

# Wiki estática — copia só os arquivos do site pra raiz do nginx
COPY index.html ONBOARDING.md /usr/share/nginx/html/

EXPOSE 80
