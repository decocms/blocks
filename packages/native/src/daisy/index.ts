/// <reference types="nativewind/types" />
// A referência precisa estar AQUI, não num .d.ts solto do pacote: o framework
// exporta .ts cru, então o `tsc` do consumidor compila esta fonte com o
// tsconfig DELE — e um .d.ts que só o tsconfig do pacote inclui não viaja
// junto. Sem isto, todo consumidor vê "Property 'className' does not exist".
/**
 * DaisyUI-compatible components for React Native.
 *
 * **Not a CSS shim.** The reason a shim cannot work is that DaisyUI's
 * interaction model is written in selectors — `.modal-toggle:checked + .modal`,
 * `.drawer-toggle:checked ~ .drawer-side` — and React Native has neither
 * sibling selectors nor `:checked`. What does not port is state, not style.
 *
 * The second reason this layer has to exist: DaisyUI classes are **not inert**
 * in RN, they crash. See `variants.ts` for the mechanism.
 *
 * So each component takes the DaisyUI class string as its variant API — ported
 * code keeps reading `className="btn btn-primary"` — parses it, and emits plain
 * Tailwind utilities that NativeWind resolves against the site's own `@theme`.
 * Same colours as the web, by construction.
 *
 * Requires `nativewind` (optional peer). Nothing else in `@decocms/native`
 * does.
 */

export {
  Badge,
  type BadgeProps,
  Button,
  type ButtonProps,
  Card,
  CardBody,
  Divide,
  Indicator,
  Input,
  type InputProps,
  Join,
  Loading,
} from "./atoms";
export { Carousel, type CarouselProps } from "./Carousel";
export {
  Collapse,
  type CollapseProps,
  Drawer,
  type DrawerProps,
  Modal,
  type ModalProps,
  Tabs,
  type TabsProps,
} from "./stateful";
export {
  bgOf,
  borderOf,
  cx,
  type DaisyColor,
  type DaisySize,
  type DaisyVariants,
  fgOf,
  parseVariants,
} from "./variants";
