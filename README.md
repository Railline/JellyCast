# JellyCast

JellyCast ajoute un bouton permanent **Reprendre ici** à Jellyfin Web. Depuis
n’importe quel appareil connecté au compte, il permet de récupérer la vidéo
en cours de lecture sur un autre appareil, à la même position.

## Fonctionnement

1. JellyCast injecte son script dans la réponse `index.html` de Jellyfin Web,
   sans modifier les fichiers sur disque.
2. Le bouton **Reprendre ici** apparaît en bas à droite après la connexion.
3. Le plugin liste uniquement les lectures actives des autres appareils
   rattachés au compte courant.
4. Jellyfin reprend le média sur l’appareil actuel avec la position courante,
   puis arrête la lecture sur l’ancien appareil.

Le média reste diffusé directement par votre serveur Jellyfin : JellyCast ne
relaie pas le flux et ne transmet aucun jeton à un service externe.

## Compatibilité

- Jellyfin Server 10.11.x
- Jellyfin Web classique
- appareils qui déclarent prendre en charge le contrôle à distance Jellyfin

L’ajout du bouton repose sur une extension non officielle de Jellyfin Web.
Une mise à jour majeure de l’interface peut donc demander une adaptation des
sélecteurs. Les clients natifs qui n’embarquent pas Jellyfin Web n’affichent
pas le bouton, mais peuvent être des cibles s’ils acceptent les commandes.

## Installation

Dans Jellyfin, ouvrez **Tableau de bord → Plugins → Dépôts**, puis ajoutez :

```text
https://raw.githubusercontent.com/Railline/JellyCast/main/manifest.json
```

Ouvrez ensuite le catalogue, installez JellyCast et redémarrez le serveur.

### Installation manuelle

1. Téléchargez l’archive de la dernière release, ou compilez la DLL.
2. Créez un dossier `JellyCast` dans le répertoire `plugins` de Jellyfin.
3. Copiez la DLL dans ce dossier.
4. Redémarrez Jellyfin, puis rechargez complètement l’interface web.

Compilation :

```bash
dotnet build --configuration Release
```

La DLL se trouve dans
`Jellyfin.Plugin.JellyCast/bin/Release/net9.0/`.

## Développement

```bash
npm test
npm run check
dotnet build
```

## Sécurité

JellyCast réutilise l’authentification du client Jellyfin. Le filtrage côté
client limite la sélection au compte courant, et le serveur Jellyfin vérifie
encore les droits de contrôle à distance lors de la commande.

## Licence

GPL-3.0-or-later.
