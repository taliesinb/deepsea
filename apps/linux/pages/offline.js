const params = new URLSearchParams(location.search)
const title = params.get('title') || 'DeepSea is unreachable'
document.title = title
document.querySelector('#title').textContent = title
document.querySelector('#reason').textContent = params.get('reason') || ''
document.querySelector('#address').textContent = params.get('address') || ''
document.querySelector('#auto').hidden = params.get('retry') !== '1'
const retry = document.querySelector('#retry')
retry.addEventListener('click', () => {
  retry.disabled = true
  retry.textContent = 'Reconnecting…'
  window.deepseaClient.retry()
})
document.querySelector('#change').addEventListener('click', () => window.deepseaClient.changeServer())
