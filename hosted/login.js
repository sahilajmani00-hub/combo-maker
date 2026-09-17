const params = new URLSearchParams(location.hash.slice(1))
let invitation = params.get('invite')
const form = document.querySelector('#login-form')
const email = document.querySelector('#email')
const password = document.querySelector('#password')
const button = document.querySelector('#submit')
const message = document.querySelector('#message')
if (invitation) {
  // Remove the private token from visible browser history immediately.
  history.replaceState(null, '', '/login')
  email.value = params.get('email') || ''
  document.querySelector('#title').textContent = "You're invited."
  document.querySelector('#description').textContent = 'Choose a password to activate your private workspace access.'
  document.querySelector('#password-label').textContent = 'Create password'
  document.querySelector('#password-help').hidden = false
  password.autocomplete = 'new-password'
  password.minLength = 12
  button.textContent = 'Activate account'
}
form.addEventListener('submit', async (event) => {
  event.preventDefault()
  button.disabled = true
  message.textContent = ''
  try {
    const response = await fetch(invitation ? '/auth/activate' : '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value, password: password.value, token: invitation }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Could not sign in. Please try again.')
    invitation = null
    location.replace('/')
  } catch (error) {
    message.textContent = error.message || 'Connection failed. Please try again.'
    button.disabled = false
  }
})
