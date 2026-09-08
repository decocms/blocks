/// <reference types="nativewind/types" />
/**
 * Imagem do CMS: redimensionada no CDN, cacheada e adiantável.
 *
 * ## Por que isto existe
 *
 * Um `<Image source={{uri}}>` com a URL crua do CMS baixa o original. Medido
 * num storefront real: **1,34 MB** por foto de produto para desenhar um card
 * de 160 dp, e **1,62 MB** no banner da home — ~8 MB só para pintar uma
 * prateleira de seis. Com o resize do CDN viram **79 KB** e **15 KB**. 17× e
 * 106×.
 *
 * Nenhum cache resolve isso: o primeiro carregamento já é o problema, e é o
 * único que o usuário julga.
 *
 * ## Por que o app não monta a URL sozinho
 *
 * Cada CDN tem sintaxe própria — Shopify é `&width=&height=&crop=center`, VTEX
 * tem o formato `/arquivos/ids/`, e o decoims é `/image?fit=&width=&src=`.
 * Notavelmente, `?width=` no decoims **não faz nada** e devolve o original
 * inteiro, sem erro. `getOptimizedMediaUrl` (`@decocms/blocks/hooks`) é o mesmo
 * builder que o site usa e cobre os três.
 *
 * ## Por que o backend é injetado
 *
 * `expo-image` traz cache em disco, `transition` e `recyclingKey`, e é o que
 * um app deveria usar. Mas o pacote não depende de Expo — nada aqui deve
 * obrigar um app React Native puro a adotá-lo. Então o backend é registrado uma
 * vez no boot; sem registro, cai no `Image` do react-native e tudo continua
 * funcionando, só sem cache em disco nem prefetch.
 */

import { getOptimizedMediaUrl } from "@decocms/blocks/hooks";
import { type ComponentType, createElement } from "react";

/**
 * `require` preguiçoso em vez de import de topo.
 *
 * O `react-native` é distribuído com tipos Flow, que nenhum runner de teste em
 * Node consegue parsear — um import de topo tornaria este módulo, e qualquer
 * um que o importe, impossível de testar fora de um device. Mesmo motivo do
 * `session.ts`. A parte pura (montar a URL, decidir o prefetch) é justamente a
 * que tem regra de negócio, e é a que precisa de teste.
 */
function reactNative(): { Image?: unknown; PixelRatio?: { get(): number } } {
  try {
    return require("react-native");
  } catch {
    return {};
  }
}

export type ImageFit = "cover" | "contain";

/** O que o componente registrado precisa aceitar. */
export interface ImageBackendProps {
  source: { uri: string };
  style?: unknown;
  accessibilityLabel?: string;
  contentFit?: ImageFit;
  /** Amarra o pixel à URL — sem isto uma lista reciclada mostra a foto errada por um frame. */
  recyclingKey?: string;
  cachePolicy?: string;
  transition?: number;
}

export interface ImageBackend {
  /**
   * `ComponentType<any>` de propósito.
   *
   * Um `ComponentType<ImageBackendProps>` obrigaria o backend a aceitar
   * EXATAMENTE estes props, e nenhuma biblioteca real faz isso — o `style` do
   * `expo-image` é mais estreito que `unknown`, então o componente dele não é
   * atribuível e o app precisaria de um cast só para registrar. Aqui a
   * exigência é a de uso (o que passamos), não a de identidade.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Image: ComponentType<any>;
  /** Baixa antes de aparecer. Ausente = `prefetchImages` vira no-op. */
  prefetch?: (urls: string[]) => void | Promise<unknown>;
}

let backend: ImageBackend | undefined;

/**
 * Registra o backend de imagem. Chame uma vez no boot.
 *
 * ```ts
 * import { Image } from "expo-image";
 * setImageBackend({ Image, prefetch: (urls) => Image.prefetch(urls, { cachePolicy: "memory-disk" }) });
 * ```
 */
export function setImageBackend(next: ImageBackend): void {
  backend = next;
}

/**
 * A URL final, no tamanho em que a imagem será desenhada.
 *
 * Exportada porque o prefetch PRECISA gerar exatamente esta URL. Um prefetch
 * que calcula o tamanho por conta própria aquece uma entrada de cache que
 * ninguém vai pedir — e parece estar funcionando.
 */
export function optimizedImageUrl(
  src: string,
  width: number,
  height?: number,
  fit: ImageFit = "cover",
): string {
  // Densidade real do aparelho, com teto em 3: um iPhone Pro é @3x, e pedir @4
  // dobraria o payload sem diferença visível.
  const scale = Math.min(reactNative().PixelRatio?.get() ?? 1, 3);
  return (
    getOptimizedMediaUrl({
      originalSrc: src,
      width: Math.round(width * scale),
      height: height ? Math.round(height * scale) : undefined,
      fit,
    }) || src
  );
}

export interface DecoImageProps {
  src?: string;
  /**
   * Recorte alternativo do CMS.
   *
   * A escolha é SEMPRE `mobile`: o app É um celular. Comparar com um breakpoint,
   * copiando a lógica do site, faz um tablet receber a arte de desktop — que no
   * CMS costuma ser 1320x480 pensada para banner horizontal. Errado por
   * construção, não por tamanho.
   */
  mobile?: string;
  desktop?: string;
  alt?: string;
  /** Largura em dp do espaço onde a imagem é desenhada. */
  width: number;
  /** Altura em dp. Sem ela o CDN corta pela largura. */
  height?: number;
  fit?: ImageFit;
  style?: unknown;
}

export function DecoImage({
  src,
  mobile,
  desktop,
  alt,
  width,
  height,
  fit = "cover",
  style,
}: DecoImageProps) {
  const original = src ?? mobile ?? desktop;
  if (!original) return null;

  const uri = optimizedImageUrl(original, width, height, fit);

  if (!backend) {
    // Sem backend registrado: funciona, só sem cache em disco. `resizeMode` em
    // vez de `contentFit` porque a prop do react-native tem outro nome.
    return createElement(reactNative().Image as ComponentType<unknown>, {
      source: { uri },
      accessibilityLabel: alt,
      style,
      resizeMode: fit,
    } as never);
  }

  return createElement(backend.Image, {
    source: { uri },
    accessibilityLabel: alt,
    style,
    contentFit: fit,
    recyclingKey: uri,
    cachePolicy: "memory-disk",
    transition: 150,
  });
}

/**
 * Baixa imagens antes de elas aparecerem.
 *
 * Usa `optimizedImageUrl`, a MESMA função do render — é o que garante que a
 * entrada aquecida seja a que vai ser pedida.
 *
 * No-op sem backend, ou sem `prefetch` nele: um app sem cache não ganha nada
 * baixando cedo.
 */
export function prefetchImages(
  sources: Array<string | undefined>,
  width: number,
  height?: number,
  fit: ImageFit = "cover",
): void {
  if (!backend?.prefetch) return;
  const urls = sources.filter((s): s is string => Boolean(s)).map((s) =>
    optimizedImageUrl(s, width, height, fit),
  );
  if (urls.length === 0) return;
  // Fire-and-forget: prefetch que falha custa um cache miss, nunca um erro na
  // tela.
  void Promise.resolve(backend.prefetch(urls)).catch(() => {});
}

/** Só para testes — devolve o backend ao estado não-registrado. */
export function resetImageBackend(): void {
  backend = undefined;
}
