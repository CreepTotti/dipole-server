# DiPole szerver — telepítés a saját tárhelyre (SSH)

Ez a szerver egy **tartósan futó Node.js folyamat**, ami WebSocket-kapcsolatot
fogad (Socket.io). Ez több, mint amit egy sima FTP+PHP tárhely tud — de SSH
hozzáféréssel simán megoldható.

## 0. Előfeltételek ellenőrzése

```bash
ssh <felhasznalonev>@<szerver>
node -v      # 18+ ajánlott (a fejlesztés Node 22-n történt, de 18+ is jó)
npm -v
which pm2 || npm install -g pm2    # ha nincs jogod globális telepítéshez, lásd 3. lépés alternatíva
```

Ha a `node -v` nem talál semmit vagy nagyon régi (10 alatti), szólj — sok
cPanel-es tárhelyen a Node.js-t külön kell engedélyezni (pl. "Setup Node.js
App" a vezérlőpulton, vagy NVM).

## 1. Fájlok feltöltése

A mellékelt `dipole-server-f1.zip` tartalmát töltsd fel (scp/rsync/FTP —
amelyik kényelmesebb), pl. `~/dipole-server/` alá.

## 2. Függőségek telepítése

```bash
cd ~/dipole-server
npm install --production
```

## 3. Indítás tartósan futó módban

**Ha van pm2** (ajánlott — túléli az SSH-kilépést és könnyen újraindítható):

```bash
pm2 start src/server.js --name dipole-server
pm2 save
pm2 startup   # kiírja a parancsot, amit futtatva szerver-újraindítás után is elindul
```

**Ha nincs pm2 és nem telepíthető** (ideiglenes megoldás, nem éli túl a
szerver újraindítását):

```bash
nohup node src/server.js > server.log 2>&1 & disown
```

Alapértelmezett port: **4000** (felülírható: `PORT=8080 node src/server.js`).

## 4. Elérhetővé tétel kívülről — ez a lényeg

A legtöbb tárhely tűzfala kívülről csak a 80/443-as portot engedi át, egy
tetszőleges portot (pl. 4000) valószínűleg nem. Két járható út:

### A) Reverse proxy a meglévő webszerveren (ajánlott)

Ha Apache vagy nginx szolgálja ki a dipole.hu-t (valószínűleg igen, ha van
SSL-tanúsítványod), a legegyszerűbb egy aldomain, ami a belső 4000-es
portra irányít.

**nginx** (pl. `ws.dipole.hu` aldomainhez):

```nginx
server {
    listen 443 ssl;
    server_name ws.dipole.hu;
    # ... a meglévő SSL-tanúsítvány beállításai ...
    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

**Apache** (kell hozzá a `mod_proxy_wstunnel` modul):

```apache
<VirtualHost *:443>
    ServerName ws.dipole.hu
    # ... a meglévő SSL-tanúsítvány beállításai ...
    ProxyPass / http://127.0.0.1:4000/
    ProxyPassReverse / http://127.0.0.1:4000/
    RewriteEngine on
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteRule /(.*) ws://127.0.0.1:4000/$1 [P,L]
</VirtualHost>
```

Ezután a szerver publikus címe: **`wss://ws.dipole.hu`**

### B) Közvetlen port (ha a szolgáltatód engedi)

Ha a tárhelyed engedi tetszőleges port kívülről való elérését, a szerver
közvetlenül elérhető: **`ws://dipole.hu:4000`** (TLS nélkül — mivel a
kliens jelenleg egy sima HTML fájlból fut, nem https oldalról, ez egyelőre
működőképes, de véglegesen az A) opció a biztonságosabb).

## 5. Ellenőrzés

A saját gépedről (nem erről a szerverről):

```bash
curl -i "https://ws.dipole.hu/socket.io/?EIO=4&transport=polling"
```

Ha 200-as választ kapsz vissza (nem timeout, nem "connection refused"), a
szerver elérhető kívülről.

## 6. Utána

Küldd el a végleges címet (pl. `wss://ws.dipole.hu` vagy `ws://dipole.hu:4000`)
— ezt beépítem a `game-beta.html`-be, és onnantól a saját gépeden, két
böngészőablakban ki tudod próbálni az online módot.
