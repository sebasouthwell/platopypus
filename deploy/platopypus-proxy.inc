# Proxy to the PlatOpypus process on loopback. Installed to /etc/nginx/conf.d/platopypus-proxy.inc.
proxy_pass http://127.0.0.1:7331;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
proxy_request_buffering off;
proxy_buffering off;
