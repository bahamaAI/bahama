import app from '../server/index.js'

export default {
  fetch(request: Request) {
    return app.fetch(request)
  },
}
