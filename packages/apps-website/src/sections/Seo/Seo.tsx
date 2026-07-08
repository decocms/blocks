import SeoComponent, { type Props as SeoProps } from "../../components/Seo";

type Props = Omit<SeoProps, "jsonLDs">;

/**
 * @deprecated true
 * @migrate website/sections/Seo/SeoV2.tsx
 * @title SEO deprecated
 */
function Section(props: Props) {
	return <SeoComponent {...props} />;
}

export default Section;
