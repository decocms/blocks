/**
 * `carousel` + `carousel-item`.
 *
 * The only family in this module that gets *smaller* in the port. DaisyUI v5
 * dropped carousel overflow, so this storefront re-adds `scroll-snap-type` by
 * hand in `app.css`, and drives it from a ~170-line `useEffect` that mutates
 * the DOM directly: `getElementById`, `querySelectorAll`, `IntersectionObserver`,
 * `scrollTo`, `setAttribute("disabled")` on nodes it does not own — with zero
 * React state.
 *
 * None of that ports, and none of it needs to: `snapToInterval` IS scroll-snap,
 * and `onViewableItemsChanged` IS the IntersectionObserver. What was manual on
 * the web is a prop here.
 *
 * Deliberately not carried over: pagination by "visible items" (item width is
 * explicit here, so a page is one item) and pause-on-hover, which has no touch
 * equivalent.
 */

import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { Dimensions, FlatList, Pressable, View, type ViewToken } from "react-native";
import { cx } from "./variants";

export interface CarouselProps<T> {
  data: T[];
  renderItem: (item: T, index: number) => ReactElement;
  keyExtractor?: (item: T, index: number) => string;
  /** Width of each item. Defaults to the screen — a full-bleed banner. */
  itemWidth?: number;
  gap?: number;
  /** Autoplay interval in ms. Absent = off. */
  interval?: number;
  /** Wrap past the last item. Only affects autoplay. */
  infinite?: boolean;
  showDots?: boolean;
  className?: string;
}

export function Carousel<T>({
  data,
  renderItem,
  keyExtractor,
  itemWidth = Dimensions.get("window").width,
  gap = 0,
  interval,
  infinite = true,
  showDots = true,
  className,
}: CarouselProps<T>) {
  const ref = useRef<FlatList<T>>(null);
  const [active, setActive] = useState(0);
  const stride = itemWidth + gap;

  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems[0];
    if (typeof first?.index === "number") setActive(first.index);
  }).current;
  // Same 60% threshold the web Slider uses.
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;

  const goTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= data.length) return;
      ref.current?.scrollToOffset({ offset: index * stride, animated: true });
    },
    [data.length, stride],
  );

  useEffect(() => {
    if (!interval || data.length < 2) return;
    const id = setInterval(() => {
      setActive((cur) => {
        const next = cur + 1;
        if (next >= data.length) {
          if (!infinite) return cur;
          ref.current?.scrollToOffset({ offset: 0, animated: true });
          return 0;
        }
        ref.current?.scrollToOffset({ offset: next * stride, animated: true });
        return next;
      });
    }, interval);
    return () => clearInterval(id);
  }, [interval, infinite, data.length, stride]);

  if (data.length === 0) return null;

  return (
    <View className={className}>
      <FlatList
        ref={ref}
        data={data}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={stride}
        decelerationRate="fast"
        getItemLayout={(_, i) => ({ length: stride, offset: stride * i, index: i })}
        keyExtractor={keyExtractor ?? ((_, i) => String(i))}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={viewabilityConfig}
        ItemSeparatorComponent={gap ? () => <View style={{ width: gap }} /> : null}
        renderItem={({ item, index }) => (
          <View style={{ width: itemWidth }}>{renderItem(item, index)}</View>
        )}
      />

      {showDots && data.length > 1 && (
        <View className="flex-row items-center justify-center gap-2 py-4">
          {data.map((_, i) => (
            <Pressable
              // biome-ignore lint/suspicious/noArrayIndexKey: position IS the identity
              key={i}
              onPress={() => goTo(i)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`go to item ${i + 1}`}
              // `disabled:w-8 transition-[width]` on the web: the active dot is a bar.
              className={cx("h-2 rounded-full", i === active ? "w-8 bg-primary" : "w-2 bg-gray-300")}
            />
          ))}
        </View>
      )}
    </View>
  );
}
