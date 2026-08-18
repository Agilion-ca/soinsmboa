import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// ── Bilingual text helpers ────────────────────────────────────────────────────

const bilingualText = z.object({
  fr: z.string(),
  en: z.string(),
});

const bilingualTextOptional = z.object({
  fr: z.string().optional().default(''),
  en: z.string().optional().default(''),
});

// ── Blog collection ───────────────────────────────────────────────────────────

const blog = defineCollection({
  loader: glob({ pattern: '!(_index)*.json', base: './src/content/blog' }),
  schema: z.object({
    meta: z.object({
      slug: z.string(),
      date: z.string(),
      title: bilingualText,
      description: bilingualText,
      focus_keyword: bilingualText,
      reading_time: z.number().int().min(1).default(5),
      category: z.enum([
        'couts',
        'guide_pratique',
        'sante_personnes_agees',
        'diaspora',
        'juridique_administratif',
      ]),
      tags: z.array(z.string()).default([]),
      internal_links: z
        .array(
          z.object({
            href: z.string(),
            text: bilingualText,
          })
        )
        .default([]),
    }),

    hero: z.object({
      src: z.string(),
      alt: bilingualText,
      photographer: z.string().nullable().default(null),
      photographer_url: z.string().nullable().default(null),
      photo_url: z.string().nullable().default(null),
      unsplash_id: z.string().nullable().default(null),
    }),

    body_images: z
      .array(
        z.object({
          src: z.string(),
          alt: bilingualText,
          caption: bilingualTextOptional.optional(),
          photographer: z.string().nullable().default(null),
          photographer_url: z.string().nullable().default(null),
          photo_url: z.string().nullable().default(null),
        })
      )
      .default([]),

    content: z.object({
      chapeau: bilingualText,
      sections: z.array(
        z.object({
          heading: bilingualText,
          body: bilingualText,
          image: z
            .object({
              src: z.string(),
              alt: bilingualText,
            })
            .nullable()
            .default(null),
        })
      ),
      faq: z.array(
        z.object({
          question: bilingualText,
          answer: bilingualText,
        })
      ),
      conclusion: bilingualText,
      cta: z.object({
        text: bilingualText,
        href: z.string(),
      }),
    }),

    sources: z
      .array(
        z.object({
          title: z.string(),
          url: z.string(),
          org: z.string(),
        })
      )
      .default([]),

    related: z.array(z.string()).default([]),

    schema: z
      .object({
        faq_items: z
          .array(
            z.object({
              question: bilingualText,
              answer: bilingualText,
            })
          )
          .default([]),
      })
      .default({ faq_items: [] }),
  }),
});

export const collections = { blog };
