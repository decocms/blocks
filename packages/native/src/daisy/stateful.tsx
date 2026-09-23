/**
 * The DaisyUI families whose port is a state machine, not a stylesheet.
 *
 * This is the load-bearing half. Counting the six families the storefront's
 * home uses: `:has()` ×7, `:checked` ×6, `:hover` ×3, `::before/after` ×3 — and
 * the interaction model is written entirely in CSS selectors:
 *
 * ```css
 * .modal-toggle:checked + .modal
 * .drawer-toggle:checked ~ .drawer-side
 * ```
 *
 * React Native has no sibling selector and no `:checked`, and no CSS shim can
 * fix that, because what is missing is not CSS — it is state. So each component
 * here keeps the DaisyUI class string as its API and replaces the hidden
 * checkbox with `useState`, which is also what the web version should have been.
 */

import { type ReactNode, useState } from "react";
import {
  Modal as RNModal,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { cx } from "./variants";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** `modal-bottom` renders as a sheet — the phone-shaped default. */
  className?: string;
}

/**
 * `modal` + `modal-box` + `modal-backdrop`.
 *
 * `open` is a real prop instead of DaisyUI's `.modal-toggle:checked`. The
 * backdrop closes on press, which on the web is `<form method="dialog">` inside
 * `.modal-backdrop` — a trick with no native equivalent.
 */
export function Modal({ open, onClose, children, className }: ModalProps) {
  const bottom = (className ?? "").includes("modal-bottom");
  return (
    <RNModal visible={open} transparent animationType={bottom ? "slide" : "fade"} onRequestClose={onClose}>
      <Pressable className="flex-1 justify-center bg-black/50" onPress={onClose}>
        {/* Stops the press from bubbling to the backdrop. On the web this is
            `stopPropagation`; here an inner Pressable with no handler is what
            swallows the touch. */}
        <Pressable
          onPress={() => {}}
          className={cx(
            "mx-5 max-h-[80%] rounded-lg bg-base-100 p-5",
            bottom && "mx-0 mb-0 mt-auto rounded-b-none",
          )}
        >
          {children}
        </Pressable>
      </Pressable>
    </RNModal>
  );
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Panel contents — the `.drawer-side` of the web version. */
  side: ReactNode;
  /** `drawer-end` puts the panel on the right. */
  className?: string;
  children?: ReactNode;
}

/**
 * `drawer` + `drawer-side` + `drawer-toggle`.
 *
 * On the web the panel is always in the DOM, translated off-screen by
 * `.drawer-toggle:checked ~ .drawer-side`. Here it is a `Modal`, so it is not
 * mounted at all while closed — which is also why a drawer holding a heavy
 * list is cheaper on a device than on the web.
 */
export function Drawer({ open, onClose, side, className, children }: DrawerProps) {
  const end = (className ?? "").includes("drawer-end");
  const { width } = useWindowDimensions();
  return (
    <>
      {children}
      <RNModal visible={open} transparent animationType="slide" onRequestClose={onClose}>
        <Pressable className={cx("flex-1 bg-black/50", end ? "items-end" : "items-start")} onPress={onClose}>
          <Pressable
            onPress={() => {}}
            className="h-full bg-base-100"
            // 80% of the viewport, capped — the web uses `w-80`, which is a
            // third of a desktop and most of a phone.
            style={{ width: Math.min(width * 0.85, 360) }}
          >
            {side}
          </Pressable>
        </Pressable>
      </RNModal>
    </>
  );
}

export interface CollapseProps {
  title: ReactNode;
  children: ReactNode;
  /** Starts open. */
  defaultOpen?: boolean;
  /** `collapse-arrow` / `collapse-plus` — only the marker differs. */
  className?: string;
}

/**
 * `collapse` + `collapse-title` + `collapse-content`.
 *
 * DaisyUI hides the content with `grid-template-rows: 0fr` toggled by
 * `:checked`. There is no grid in RN, and animating height is a Reanimated
 * job — so this mounts and unmounts. Instant instead of animated, which on a
 * list of FAQ rows nobody misses.
 */
export function Collapse({ title, children, defaultOpen = false, className }: CollapseProps) {
  const [open, setOpen] = useState(defaultOpen);
  const plus = (className ?? "").includes("collapse-plus");
  const marker = plus ? (open ? "−" : "+") : open ? "▲" : "▼";
  return (
    <View className="border-b border-gray-200">
      <Pressable
        className="flex-row items-center justify-between px-4 py-4"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
      >
        {typeof title === "string" ? <Text className="text-base font-medium">{title}</Text> : title}
        <Text className="text-xs text-gray-500">{marker}</Text>
      </Pressable>
      {open ? <View className="px-4 pb-4">{children}</View> : null}
    </View>
  );
}

export interface TabsProps {
  tabs: Array<{ label: string; content: ReactNode }>;
  /** `tabs-boxed` / `tabs-bordered`. */
  className?: string;
  defaultIndex?: number;
}

/**
 * `tabs` + `tab` + `tab-active`.
 *
 * The web version is radio inputs styled by `:checked`; here the active index
 * is state. Worth noting for anyone porting `ProductShelfTabbed`: on this
 * storefront the web "tabbed" shelf renders only `tabs[0]` and still runs every
 * tab's loader server-side. Real tabs are strictly cheaper.
 */
export function Tabs({ tabs, className, defaultIndex = 0 }: TabsProps) {
  const [active, setActive] = useState(defaultIndex);
  const boxed = (className ?? "").includes("tabs-boxed");
  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 20, gap: 8 }}
        className={cx(boxed && "py-2")}
      >
        {tabs.map((tab, i) => (
          <Pressable
            key={tab.label}
            onPress={() => setActive(i)}
            accessibilityRole="tab"
            accessibilityState={{ selected: i === active }}
            className={cx(
              "px-4 py-2",
              boxed ? "rounded" : "border-b-2",
              i === active
                ? boxed ? "bg-primary" : "border-primary"
                : boxed ? "bg-transparent" : "border-transparent",
            )}
          >
            <Text
              className={cx(
                "text-sm",
                i === active
                  ? boxed ? "font-semibold text-white" : "font-semibold text-primary"
                  : "text-gray-500",
              )}
            >
              {tab.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      <View>{tabs[active]?.content}</View>
    </View>
  );
}
