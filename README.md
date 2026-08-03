# Control de barras

PWA estática para verificar un packing list de barras doré contra la balanza.
Todo corre en el teléfono: el packing list nunca sale del dispositivo.

## Cómo funciona

Las barras llegan sin marcar. El trabajo es averiguar qué item es cada una y
pintarle el número. La app hace la parte de averiguar.

1. Cargas el packing list en `.xlsx`. La app detecta sola la fila de cabecera
   (busca la columna `ITEM`) y lee `Bruto - Cliente`, `LEY` y `PESO PURO`.
2. Al cargarlo te dice cuál es el par de pesos más cercano del embarque, y te
   frena si hay pares que el peso no puede separar.
3. Pones la barra en la balanza y tecleas el peso.
4. La app te dice qué número pintar, con la diferencia contra la lista y cuánto
   margen le saca al segundo candidato.
5. Pintas y confirmas. Esa barra sale del pool y su casilla en el progreso
   pasa a mostrar el peso con el que quedó asignada — así, más adelante, para
   verificarla basta con volver a pesarla y comparar contra ese número.

### Corregir una asignación

Si te equivocaste al confirmar, toca la casilla de esa barra en la sección de
Progreso. Se precarga el peso con el que se asignó; vuelve a pesar (o ajusta
el valor) y confirma para sobreescribir el registro. No afecta al resto del
pool.

## Alertas

| Situación | Aviso |
|---|---|
| Delta < 0.5 g y buen margen sobre el 2º candidato | Verde |
| Delta > 2.0 g contra la lista | Rojo |
| El 2º candidato a menos de 3.0 g del primero | Rojo — no pintes |
| Última barra del embarque (asignada por descarte) | Ámbar |

Las tolerancias están en las tres primeras constantes de `app.js`.

`TOL_AMBIG` es la más importante: sin pintura previa, el margen sobre el segundo
candidato es lo único que sostiene la asignación. En `PACK_EXPO_015` el par más
cercano son los items 5 y 16, separados por 6.10 g — más del doble del umbral.

## Despliegue en GitHub Pages

```bash
cd barras
git init
git add .
git commit -m "Control de barras: verificacion de packing list"

gh repo create control-barras --public --source=. --push
gh api -X POST repos/:owner/control-barras/pages \
  -f "source[branch]=main" -f "source[path]=/"
```

Queda en `https://<usuario>.github.io/control-barras/` al cabo de un par de minutos.

Si `gh` no está instalado: `brew install gh && gh auth login`.

## En el iPhone

Abre la URL en Safari, comparte, **Añadir a pantalla de inicio**. Este paso no es
opcional: Safari borra IndexedDB tras ~7 días de inactividad en sitios que no están
instalados. Instalada, la app queda exenta.

Ábrela una vez con conexión para que el service worker cachee las librerías.
Después funciona sin señal.

## Datos

- Las asignaciones viven en IndexedDB, solo en ese teléfono.
- No hay backup automático. **Exporta el CSV cuando termines un embarque.**
- Cargar un nuevo packing list reemplaza el embarque y las asignaciones anteriores.

## Nunca commitear

El `.gitignore` bloquea `*.xlsx`, `*.csv`, `*.pdf` y `*.zip`. El repo es público:
el packing list no entra ahí bajo ningún concepto.

## Archivos

```
index.html      UI y estilos
app.js          parseo, matching, IndexedDB, exportación
sw.js           service worker (offline)
manifest.json   metadatos PWA
icon-192.png    iconos
icon-512.png
```

## Ideas para después

- OCR del display de la balanza para precargar el peso (Mettler Toledo,
  siete segmentos, buen contraste: es un caso favorable).
- Huella visual: guardar la foto de cada barra al asignarla y compararla en
  embarques futuros. Resolvería los casos donde el peso no basta.
- Firma del operador y hora en el CSV si alguna vez hace falta para auditoría.
