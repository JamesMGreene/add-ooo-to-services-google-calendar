// Use UTC for all Date parsing
process.env.TZ = 'UTC'

// Userland modules
const { Toolkit } = require('actions-toolkit')
const { google } = require('googleapis')

// Local modules
const dateColumnMapper = require('./src/date-column-mapper')
const loginRowMapperGenerator = require('./src/login-row-mapper-generator')
const extractOooCommandDates = require('./src/extract-ooo-command-dates')
const areDatesEqual = require('./src/are-dates-equal')
const formatDate = require('./src/format-date')
const isWeekdayDate = require('./src/is-weekday-date')
const getActualValueFromExtendedValue = require('./src/get-actual-value-from-extended-value')

// IMPORTANT: This mapper can only be used serially
const loginRowMapper = loginRowMapperGenerator()

const requiredNonSecretEnvVars = ['SPREADSHEET_ID', 'SHEET_NAME', 'DATE_ROW', 'LOGIN_COL']

const tools = new Toolkit({
  // If the event received is not included,
  // Toolkit will exit neutrally
  event: ['issue_comment.created'],

  // If the following environment variables are not present,
  // Toolkit will exit with a failure
  secrets: [
    // The built-in Actions secret to enable GitHub API calls
    'GITHUB_TOKEN',
    // The email address of a GCP Service Account with access to the spreadsheet
    'GOOGLE_API_CLIENT_EMAIL',
    // The private key of a GCP Service Account with access to the spreadsheet
    'GOOGLE_API_PRIVATE_KEY',
    ...requiredNonSecretEnvVars
  ]
})

// Wrap into an `async` function so we can using `await`
async function main() {
  const {
    GOOGLE_API_CLIENT_EMAIL,
    GOOGLE_API_PRIVATE_KEY,
    SPREADSHEET_ID,
    SHEET_NAME,
    DATE_ROW,
    LOGIN_COL
  } = process.env

  tools.log.info('Payload:')
  tools.log.info(JSON.stringify(tools.context.payload))

  const { issue, comment } = tools.context.payload
  const issueCreatorLogin = issue.user.login.toLowerCase()
  const issueTitle = issue.title
  const issueTitleLower = issueTitle.toLowerCase()
  const issueBody = issue.body
  const issueUrl = issue.html_url

  // Exit early neutrally if the issue is not an OOO issue
  if (!(issueTitleLower.includes('ooo') || issueTitleLower.includes('out of office'))) {
    tools.exit.neutral('This is not an OOO issue')
  }

  // Exit early neutrally if the issue comment is from a bot
  if (comment.user.type === 'Bot') {
    tools.exit.neutral('This comment is from a bot')
  }

  // Exit early neutrally if the issue comment is not from the issue's original author
  if (issue.user.id !== comment.user.id) {
    tools.exit.neutral('This comment is not from the OOO issue author')
  }

  const extraction = extractOooCommandDates(comment.body)
  if (!extraction) {
    tools.exit.neutral('This comment does not contain an OOO slash command')
  }

  const { startDate, endDate } = extraction
  if (!startDate || !endDate) {
    tools.exit.failure('This OOO command does not contain identifiable dates')
  }

  // Configure a JWT auth client using the Service Account
  const jwtClient = new google.auth.JWT(GOOGLE_API_CLIENT_EMAIL, null, GOOGLE_API_PRIVATE_KEY, [
    'https://www.googleapis.com/auth/spreadsheets'
  ])
  // Authenticate request (const tokens = )
  await jwtClient.authorize()

  const sheets = google.sheets('v4')

  const [dateRowRes, loginColRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      auth: jwtClient,
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!${DATE_ROW}:${DATE_ROW}`,
      majorDimension: 'ROWS'
    }),
    sheets.spreadsheets.values.get({
      auth: jwtClient,
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!${LOGIN_COL}:${LOGIN_COL}`,
      majorDimension: 'COLUMNS'
    })
  ])

  const dateColCells = dateRowRes.data.values[0].map(dateColumnMapper)
  const loginRowCells = loginColRes.data.values[0].map(loginRowMapper)

  tools.log.info('Date column cells:')
  tools.log.info(JSON.stringify(dateColCells))
  tools.log.info('Login row cells:')
  tools.log.info(JSON.stringify(loginRowCells))

  const loginRowCellForIssueCreator = loginRowCells.find(
    c => c.value && c.value.login === issueCreatorLogin
  )
  if (!loginRowCellForIssueCreator) {
    tools.exit.failure(
      `Could not find row cell matching issue creator's login "${issueCreatorLogin}" for issue: ${issueUrl}`
    )
  }

  tools.log.info('Found row cell for issue creator!')
  tools.log.info(JSON.stringify(loginRowCellForIssueCreator))

  const dateColumnCellForStartIndex = dateColCells.findIndex(c => areDatesEqual(c.value, startDate))
  const dateColumnCellForEndIndex = areDatesEqual(startDate, endDate)
    ? dateColumnCellForStartIndex
    : dateColCells.findIndex(c => areDatesEqual(c.value, endDate))

  if (dateColumnCellForStartIndex === -1 || dateColumnCellForEndIndex === -1) {
    tools.exit.failure(
      `Could not find column cells matching issue date range (${formatDate(
        startDate
      )} - ${formatDate(endDate)}) for issue: ${issueUrl}`
    )
  }

  const dateColumnCellsInRange = dateColCells.slice(
    dateColumnCellForStartIndex,
    dateColumnCellForEndIndex + 1
  )

  tools.log.info(
    `Found ${dateColumnCellsInRange.length} column cell(s) for days included in date range!`
  )

  if (dateColumnCellsInRange.length === 0) {
    tools.exit.failure('This OOO date range does not correspond to any dates in the sheet')
  }

  const weekdayColumnCellsInRange = dateColumnCellsInRange.filter(c => isWeekdayDate(c.value))
  tools.log.info(
    `Found ${weekdayColumnCellsInRange.length} column cell(s) for weekdays included in date range!`
  )
  tools.log.info(JSON.stringify(weekdayColumnCellsInRange))

  if (weekdayColumnCellsInRange.length === 0) {
    tools.exit.failure('This OOO date range only corresponds to weekend dates')
  }

  const sheetDataRes = await sheets.spreadsheets.get({
    auth: jwtClient,
    spreadsheetId: SPREADSHEET_ID,
    ranges: weekdayColumnCellsInRange.map(dateColumnCell => {
      return `'${SHEET_NAME}'!${dateColumnCell.col}${loginRowCellForIssueCreator.row}`
    }),
    includeGridData: true
  })

  const targetSheet = sheetDataRes.data.sheets[0]

  // Get the ID of the named sheet so that we can build a URL to link to the updated cells
  const namedSheetId = targetSheet.properties.sheetId

  tools.log.info('Original values:')
  tools.log.info(JSON.stringify(targetSheet.data))

  const cellValue = `=HYPERLINK("${issueUrl}", "OOO")`
  const updateValueRequests = weekdayColumnCellsInRange.map(dateColumnCell => {
    return {
      range: `'${SHEET_NAME}'!${dateColumnCell.col}${loginRowCellForIssueCreator.row}`,
      majorDimension: 'ROWS',
      values: [[cellValue]]
    }
  })

  const updateValuesRes = await sheets.spreadsheets.values.batchUpdate({
    auth: jwtClient,
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      valueInputOption: 'USER_ENTERED',
      data: updateValueRequests
    }
  })

  tools.log.info('Update values response:')
  tools.log.info(JSON.stringify(updateValuesRes))

  const firstUpdatedCell = weekdayColumnCellsInRange[0]
  const lastUpdatedCell = weekdayColumnCellsInRange[weekdayColumnCellsInRange.length - 1]

  const firstCoord = `${firstUpdatedCell.col}${loginRowCellForIssueCreator.row}`
  const lastCoord = `${lastUpdatedCell.col}${loginRowCellForIssueCreator.row}`
  const cellCoordRange = `${firstCoord}${firstCoord !== lastCoord ? ':' + lastCoord : ''}`

  const sheetRangeLink = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit#gid=${namedSheetId}&range=${cellCoordRange}`

  tools.log.info('Linked sheet range URL:')
  tools.log.info(sheetRangeLink)

  const newComment = await tools.github.issues.createComment({
    ...tools.context.repo,
    issue_number: tools.context.issue.number,
    body:
      `
The [Services schedule has been updated](${sheetRangeLink}) based on your \`ooo\` command!

<details>
  <summary>See the updates...</summary>

  <br />

  <strong>New Value:</strong>

  \`${cellValue}\`

  <strong>Old Values:</strong>

  <table>
    <tr>
      <td></td>
      <th align="left">@${comment.user.login}</th>
    </tr>
` +
      weekdayColumnCellsInRange
        .map((dateColumnCell, i) => {
          const targetDate = formatDate(dateColumnCell.value)
          const cellCoord = `${dateColumnCell.col}${loginRowCellForIssueCreator.row}`
          const sheetCellLink = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit#gid=${namedSheetId}&amp;range=${cellCoord}`
          // This ONLY covers cells that are part of a merged range but NOT the cell that provides
          // the displayed value for the range ;_;
          const wasPartOfMergedRange = !targetSheet.data[i].rowData
          const oldUserEnteredValue = wasPartOfMergedRange
            ? null
            : targetSheet.data[i].rowData[0].values[0].userEnteredValue
          const oldActualValue = wasPartOfMergedRange
            ? null
            : getActualValueFromExtendedValue(oldUserEnteredValue)
          const oldDisplayValue = wasPartOfMergedRange
            ? '<em>{belongs to a merged range... could not be updated}</em>'
            : oldActualValue === null || oldActualValue === ''
            ? '<em>{empty}</em>'
            : `<code>${oldActualValue}</code>`

          return `    <tr>
      <th nowrap>${targetDate}<br />[<a href="${sheetCellLink}">${cellCoord}</a>]</th>
      <td>${oldDisplayValue}</td>
    </tr>
`
        })
        .join('') +
      `  </table>
</details>
`
  })

  tools.exit.success('We did it!')
}

// Run the main function
main().catch(err => tools.exit.failure(err.stack))
