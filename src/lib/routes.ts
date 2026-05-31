export const routes = {
  novels: {
    list: '/novels',
    new: '/novels/new',
    detail: (id: string) => `/novels/${id}`,
    edit: (id: string) => `/novels/${id}/edit`,
    chapter: (id: string, number: number) => `/novels/${id}/chapters/${number}`
  },
  characters: {
    list: '/characters',
    new: '/characters/new',
    detail: (id: string) => `/characters/${id}`,
    edit: (id: string) => `/characters/${id}/edit`
  },
  settings: '/settings',
  login: '/login'
} as const
