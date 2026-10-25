const form = document.querySelector('form')
const field = document.querySelector('#server')
const button = document.querySelector('#connect')
const error = document.querySelector('#error')

window.deepseaClient.details().then((details) => {
  if (details.url && field.value === '') { field.value = details.url; field.select() }
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  button.disabled = true
  error.textContent = ''
  try {
    error.textContent = await window.deepseaClient.connect(field.value) || ''
  } catch (failure) {
    error.textContent = failure.message
  } finally {
    button.disabled = false
  }
})
