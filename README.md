# DekaPost

大容量ファイルをストリーミングで保存し、固有URLで共有する小さなWebアプリです。
ファイルはアップロードから7日後に自動削除されます。

## 起動

```sh
deno task start
```

`http://127.0.0.1:8000` を開き、パスキーでログインします。初期管理者を利用する場合は、
切り替え前に管理者端末でパスキーを登録しておいてください。

トップページから一般ユーザーを新規登録できます。登録時には
[NANI Terms v1.0](https://github.com/code4fukui/NANI-Terms/blob/main/versions/v1.0/TERMS-ja.md)
への同意が必要です。

## 設定

環境変数で次を変更できます。

- `HOST`: listenアドレス（既定: `127.0.0.1`）
- `PORT`: ポート（既定: `8000`）
- `DATA_DIR`: DB・アップロード保存先（既定: `./data`）
- `MAX_UPLOAD_BYTES`: 1ファイルの上限bytes（既定: 10 GiB）
- `COOKIE_SECURE=1`: HTTPS環境でsession cookieへ`Secure`を付与
- `WEBAUTHN_RP_NAME`: パスキーに表示するサービス名（既定: `DekaPost`）
- `WEBAUTHN_RP_ID`: パスキーの対象ドメイン（既定: `dekapost.sabae.cc`）
- `WEBAUTHN_ORIGIN`: パスキー検証対象のorigin（既定: `https://dekapost.sabae.cc`）

本番ではHTTPSのreverse proxy配下で起動し、proxy側のrequest
body上限とtimeoutも用途に合わせて設定してください。

## Ubuntu + nginxへデプロイ

以下はUbuntu 24.04 LTS、ドメイン名`files.example.com`、配置先`/opt/dekapost`
の例です。ドメイン名とrepository URLは実環境に置き換えてください。

### 1. 必要なpackageと実行user

```sh
sudo apt update
sudo apt install -y curl git nginx
sudo useradd --system --create-home --home-dir /var/lib/dekapost \
  --shell /usr/sbin/nologin dekapost
```

Deno公式install scriptで、service専用userの領域へ最新安定版Deno 2.xをinstallします。

```sh
sudo -u dekapost env DENO_INSTALL=/var/lib/dekapost/.deno \
  sh -c 'curl -fsSL https://deno.land/install.sh | sh'
sudo -u dekapost /var/lib/dekapost/.deno/bin/deno --version
```

UbuntuやSnapのDeno
packageは公式配布ではなく、最新版より遅れる場合があります。更新時は次を実行します。

```sh
sudo -u dekapost /var/lib/dekapost/.deno/bin/deno upgrade
```

### 2. applicationの配置

```sh
sudo git clone YOUR_REPOSITORY_URL /opt/dekapost
sudo mkdir -p /var/lib/dekapost/data
sudo chown -R root:root /opt/dekapost
sudo chown -R dekapost:dekapost /var/lib/dekapost
cd /opt/dekapost
sudo /var/lib/dekapost/.deno/bin/deno fmt --check
sudo /var/lib/dekapost/.deno/bin/deno lint
sudo /var/lib/dekapost/.deno/bin/deno check src/server.ts
sudo /var/lib/dekapost/.deno/bin/deno task test
```

application本体はroot所有、DBとアップロードファイルだけを`dekapost` userの所有にします。
`data/`にはSQLite DBと実ファイルが保存されるため、永続diskを使用してください。

### 3. systemd service

`/etc/systemd/system/dekapost.service`を作成します。

```ini
[Unit]
Description=DekaPost
After=network.target

[Service]
Type=simple
User=dekapost
Group=dekapost
WorkingDirectory=/opt/dekapost
Environment=HOST=127.0.0.1
Environment=PORT=8000
Environment=DATA_DIR=/var/lib/dekapost/data
Environment=MAX_UPLOAD_BYTES=10737418240
Environment=COOKIE_SECURE=1
Environment=WEBAUTHN_RP_NAME=DekaPost
Environment=WEBAUTHN_RP_ID=dekapost.sabae.cc
Environment=WEBAUTHN_ORIGIN=https://dekapost.sabae.cc
ExecStart=/var/lib/dekapost/.deno/bin/deno run \
  --allow-net=127.0.0.1:8000 \
  --allow-read=/opt/dekapost/public,/opt/dekapost/migrations,/var/lib/dekapost/data \
  --allow-write=/var/lib/dekapost/data \
  --allow-env=HOST,PORT,DATA_DIR,MAX_UPLOAD_BYTES,COOKIE_SECURE,WEBAUTHN_RP_NAME,WEBAUTHN_RP_ID,WEBAUTHN_ORIGIN \
  /opt/dekapost/src/server.ts
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/dekapost/data

[Install]
WantedBy=multi-user.target
```

反映して起動します。

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now dekapost
sudo systemctl status dekapost
curl -I http://127.0.0.1:8000/
```

起動logは次で確認できます。passwordやsession IDをlogへ出さないでください。

```sh
sudo journalctl -u dekapost -f
```

### 4. nginx reverse proxy

`/etc/nginx/sites-available/dekapost`を作成します。

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name files.example.com;

    client_max_body_size 10G;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 大容量uploadをnginxのtemporary fileへ全保存せずserverへ流す
        proxy_request_buffering off;
        # 大容量downloadもapplicationから逐次配信する
        proxy_buffering off;

        proxy_connect_timeout 10s;
        proxy_send_timeout 1h;
        proxy_read_timeout 1h;
    }
}
```

設定を有効化します。

```sh
sudo ln -s /etc/nginx/sites-available/dekapost /etc/nginx/sites-enabled/dekapost
sudo nginx -t
sudo systemctl reload nginx
```

`client_max_body_size`と`MAX_UPLOAD_BYTES`は同じ上限にしてください。nginxの値が小さいと、
applicationへ届く前に`413 Request Entity Too Large`になります。回線速度に応じてtimeoutも調整します。

### 5. HTTPS

productionでは必ずHTTPSを設定してください。例としてCertbotを使う場合は次のとおりです。

```sh
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d files.example.com
sudo certbot renew --dry-run
```

HTTPS設定後に新規loginし、session cookieへ`Secure`が付いていることを確認します。
HTTPだけで一時確認する場合は`COOKIE_SECURE=0`へ変更できますが、本番運用には使用しないでください。

### 6. 更新

```sh
cd /opt/dekapost
sudo git pull --ff-only
sudo /var/lib/dekapost/.deno/bin/deno fmt --check
sudo /var/lib/dekapost/.deno/bin/deno lint
sudo /var/lib/dekapost/.deno/bin/deno check src/server.ts
sudo /var/lib/dekapost/.deno/bin/deno task test
sudo systemctl restart dekapost
sudo systemctl status dekapost
```

schema変更は起動時にmigrationとして自動適用されます。更新前に
`/var/lib/dekapost/data`をbackupし、十分な空き容量があることを確認してください。
