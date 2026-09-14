import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'Zo Co-browse',
  description: 'AI that sees your page and acts through your browser — a Chrome extension powered by Zo Computer.',
  lang: 'en-US',
  // Repo is under the CCAgentOrg org, so the site publishes at a project path.
  base: '/zo-cobrowse/',

  head: [
    ['meta', { name: 'theme-color', content: '#6d5bfb' }],
    ['link', { rel: 'icon', type: 'image/png', href: '/zo-cobrowse/logo.png' }],
  ],

  themeConfig: {
    // VitePress prepends `base` ('/zo-cobrowse/') to these paths automatically.
    logo: '/logo.png',

    nav: [
      { text: 'Updates', link: '/updates' },
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'Concepts', link: '/concepts/architecture', activeMatch: '/concepts/' },
      { text: 'Reference', link: '/reference/zo-api', activeMatch: '/reference/' },
      { text: 'Development', link: '/development/setup', activeMatch: '/development/' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Using Co-browse', link: '/guide/using-cobrowse' },
            { text: 'Modes', link: '/guide/modes' },
          ],
        },
      ],
      '/concepts/': [
        {
          text: 'Concepts',
          items: [
            { text: 'Architecture', link: '/concepts/architecture' },
            { text: 'Streaming', link: '/concepts/streaming' },
            { text: 'Conversations', link: '/concepts/conversation' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Zo API', link: '/reference/zo-api' },
            { text: 'Action Protocol', link: '/reference/actions' },
            { text: 'Message Types', link: '/reference/messages' },
          ],
        },
      ],
      '/development/': [
        {
          text: 'Development',
          items: [
            { text: 'Setup & Dev Loop', link: '/development/setup' },
            { text: 'Testing & Verification', link: '/development/testing' },
            { text: 'Building & Releasing', link: '/development/building' },
          ],
        },
      ],
      '/': [
        {
          text: 'More',
          items: [
            { text: 'Updates', link: '/updates' },
            { text: 'Backend Relay', link: '/backend' },
            { text: 'Privacy', link: '/privacy' },
            { text: 'Contributing', link: '/contributing' },
            { text: 'Changelog', link: '/changelog' },
            { text: 'Roadmap', link: '/roadmap' },
          ],
        },
      ],
    },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: 'Search docs', buttonAriaLabel: 'Search docs' },
        },
      },
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/CCAgentOrg/zo-cobrowse' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 CashlessConsumer',
    },

    outline: { level: [2, 3], label: 'On this page' },

    docFooter: {
      prev: 'Previous page',
      next: 'Next page',
    },

    lastUpdated: {
      text: 'Updated',
      formatOptions: { dateStyle: 'medium', timeStyle: 'short' },
    },
  },
})
