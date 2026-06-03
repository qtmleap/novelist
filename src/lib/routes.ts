export const routes = {
  novels: {
    list: '/novels',
    new: '/novels/new',
    organize: '/novels/organize',
    detail: (id: string) => `/novels/${id}`,
    edit: (id: string) => `/novels/${id}/edit`,
    cast: (id: string) => `/novels/${id}/cast`,
    chapter: (id: string, number: number) => `/novels/${id}/chapters/${number}`
  },
  characters: {
    list: '/characters',
    new: '/characters/new',
    detail: (id: string) => `/characters/${id}`,
    edit: (id: string) => `/characters/${id}/edit`,
    variants: (id: string) => `/characters/${id}/variants`
  },
  categories: {
    list: '/categories'
  },
  settings: '/settings',
  login: '/login'
} as const
