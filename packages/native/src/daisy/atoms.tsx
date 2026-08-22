/**
 * The DaisyUI families whose port is only styling.
 *
 * Measured over the six families this storefront's home uses — 404
 * declarations — 25% depend on `var()`, 7% are web-only properties and 2% are
 * logic. That is the easy part, and it is what lives here. The families whose
 * port is a *state machine* live in `stateful.tsx`.
 */

import { type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewProps,
} from "react-native";
import {
  bgOf,
  borderOf,
  cx,
  type DaisySize,
  fgOf,
  parseVariants,
} from "./variants";

const BTN_PAD: Record<DaisySize, string> = {
  xs: "px-2 py-1",
  sm: "px-3 py-1.5",
  md: "px-4 py-2.5",
  lg: "px-6 py-3.5",
  xl: "px-8 py-4",
};
const BTN_TEXT: Record<DaisySize, string> = {
  xs: "text-xs",
  sm: "text-sm",
  md: "text-sm",
  lg: "text-base",
  xl: "text-lg",
};

export interface ButtonProps extends Omit<PressableProps, "children"> {
  /** DaisyUI classes: `btn btn-primary btn-sm btn-outline`. */
  className?: string;
  children?: ReactNode;
}

/**
 * `btn`.
 *
 * Renders text children into a `<Text>` so `className="btn"` behaves like the
 * web, where the button's colour cascades to its label. RN has no cascade, so
 * without this every caller would have to style the label itself — and would
 * forget, silently getting black text on a dark fill.
 */
export function Button({ className, children, disabled, ...rest }: ButtonProps) {
  const v = parseVariants(className, "btn");
  const surface = v.ghost
    ? ""
    : v.outline
      ? cx("border", borderOf(v.color))
      : bgOf(v.color);
  const label = v.ghost || v.outline
    ? v.color
      ? `text-${v.color}`
      : "text-gray-900"
    : fgOf(v.color);

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      className={cx(
        "flex-row items-center justify-center gap-2 rounded",
        v.circle || v.square ? "aspect-square p-0" : BTN_PAD[v.size],
        v.circle && "rounded-full",
        v.block && "w-full",
        v.wide && "min-w-32",
        surface,
        disabled && "opacity-50",
        ...v.rest,
      )}
      {...rest}
    >
      {typeof children === "string"
        ? <Text className={cx(BTN_TEXT[v.size], "font-semibold", label)}>{children}</Text>
        : children}
    </Pressable>
  );
}

export interface BadgeProps extends ViewProps {
  className?: string;
  children?: ReactNode;
}

/** `badge`. */
export function Badge({ className, children, ...rest }: BadgeProps) {
  const v = parseVariants(className, "badge");
  const surface = v.outline ? cx("border", borderOf(v.color)) : bgOf(v.color);
  const label = v.outline
    ? v.color ? `text-${v.color}` : "text-gray-900"
    : fgOf(v.color);
  return (
    <View
      className={cx(
        "items-center justify-center rounded-full px-2 py-0.5",
        surface,
        ...v.rest,
      )}
      {...rest}
    >
      {typeof children === "string"
        ? <Text className={cx("text-xs font-medium", label)}>{children}</Text>
        : children}
    </View>
  );
}

/** `card` + `card-body`. Shadow is deliberate: RN has no `box-shadow`. */
export function Card({ className, children, ...rest }: BadgeProps) {
  const v = parseVariants(className, "card");
  return (
    <View
      className={cx("overflow-hidden rounded-lg bg-base-100", ...v.rest)}
      // `shadow-*` maps to elevation on Android and shadowOpacity on iOS; both
      // are props-shaped enough that NativeWind handles them, unlike the
      // `box-shadow` DaisyUI emits.
      style={{
        shadowColor: "#000",
        shadowOpacity: 0.08,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
        elevation: 2,
      }}
      {...rest}
    >
      {children}
    </View>
  );
}

export function CardBody({ className, children, ...rest }: BadgeProps) {
  return (
    <View className={cx("gap-2 p-4", className)} {...rest}>
      {children}
    </View>
  );
}

const SPINNER_SIZE: Record<DaisySize, "small" | "large"> = {
  xs: "small",
  sm: "small",
  md: "small",
  lg: "large",
  xl: "large",
};

/**
 * `loading`.
 *
 * DaisyUI's variants (`loading-dots`, `loading-ring`, `loading-infinity`) are
 * CSS keyframe art. There is one spinner on a device, and reimplementing five
 * more in Reanimated would be decoration, not parity — so every variant maps
 * to `ActivityIndicator`.
 */
export function Loading({ className, color }: { className?: string; color?: string }) {
  const v = parseVariants(className, "loading");
  return <ActivityIndicator size={SPINNER_SIZE[v.size]} color={color} />;
}

/**
 * `indicator` + `indicator-item`.
 *
 * The web version positions the badge with `absolute` inside a `relative`
 * parent; identical here, so this is a thin wrapper that exists mainly so
 * ported code does not have to remember the anchor.
 */
export function Indicator({
  children,
  item,
  className,
}: {
  children: ReactNode;
  /** Rendered on top of the corner — usually a `<Badge>`. */
  item?: ReactNode;
  className?: string;
}) {
  return (
    <View className={cx("relative", className)}>
      {children}
      {item ? <View className="absolute -right-2 -top-2">{item}</View> : null}
    </View>
  );
}

export interface InputProps extends TextInputProps {
  className?: string;
}

/**
 * `input`.
 *
 * `input-bordered` is the default rather than an opt-in: an unbordered text
 * field on a touch device is invisible, and every caller in the storefront
 * passes it.
 */
export function Input({ className, ...rest }: InputProps) {
  const v = parseVariants(className, "input");
  const height: Record<DaisySize, string> = {
    xs: "py-1.5",
    sm: "py-2",
    md: "py-3",
    lg: "py-4",
    xl: "py-5",
  };
  return (
    <TextInput
      className={cx(
        "rounded border px-3",
        height[v.size],
        v.color ? borderOf(v.color) : "border-gray-300",
        ...v.rest,
      )}
      {...rest}
    />
  );
}

/**
 * `join` — segmented group with only the outer corners rounded.
 *
 * On the web this is `:first-child`/`:last-child` selectors. RN has no
 * sibling selectors, so position has to be computed. That is the smallest
 * example of the rule that governs this whole module: what does not port is
 * never the colour, it is the selector.
 */
export function Join({
  children,
  vertical,
  className,
}: {
  children: ReactNode[];
  vertical?: boolean;
  className?: string;
}) {
  const items = children.filter(Boolean);
  return (
    <View className={cx(vertical ? "flex-col" : "flex-row", "overflow-hidden rounded", className)}>
      {items.map((child, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: position IS the identity here
          key={i}
          className={cx(
            i > 0 && (vertical ? "border-t border-gray-200" : "border-l border-gray-200"),
          )}
        >
          {child}
        </View>
      ))}
    </View>
  );
}

/** `divide-y` — a separator between children, not around them. */
export function Divide({
  children,
  className,
}: {
  children: ReactNode[];
  className?: string;
}) {
  const items = children.filter(Boolean);
  return (
    <View className={className}>
      {items.map((child, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: position IS the identity here
        <View key={i} className={cx(i > 0 && "border-t border-gray-200")}>
          {child}
        </View>
      ))}
    </View>
  );
}
