/** The deployed web app's origin; social previews need absolute URLs. */
export const SITE_URL = "https://lunarspice.doctorthe113.com";

type PageSeo = {
  title: string;
  description: string;
  /** The page's path, such as `/app`. */
  path: string;
};

/** Title, description, canonical URL and social preview tags for one route's `head`. */
export function pageHead({ title, description, path }: PageSeo) {
  const url = `${SITE_URL}${path}`;

  return {
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: url },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
    ],
    links: [{ rel: "canonical", href: url }],
  };
}
