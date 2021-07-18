const R = require('ramda')
const cheerio = require('cheerio')
const axios = require('axios')
const xml2js = new (require('xml2js')).Parser()

// (String, String) -> Boolean
const isInternalLink = (base, link) => (
  link.startsWith(base)
    || !link.includes(':')
)

// Fix up an internal link by adding the base URL and potentially removing extra slashes
// (String, String, String) -> String
const fixInternalLink = (base, page, link) => {
  if (link.startsWith(base)) return link
  const joined = link.startsWith('/')
        ? base + link
        : page + '/' + link
  const [ protocol, rest ] = R.split('://', joined)
  return `${protocol}://${R.replace(/\/[\/]+/g, '/', rest)}`
}

// (String, String) -> Boolean
const isExternalLink = (base, link) => (
  !isInternal(base, link)
    && (link.startsWith('https://') || link.startsWith('http://'))
)

// (String, String) -> [String]
const getLinks = async (base, page) => {
  try {
    const html = (await axios(page)).data
    const $ = cheerio.load(html)
    return R.uniq(
      $('a')
        .toArray()
        .map(el => $(el).attr('href'))
        .filter(x => !!x && x !== base)
    )
  } catch (e) {
    // Ignore any page request errors
    return []
  }
}

// (String, String) -> [String]
const getInternalLinks = async (base, page) => {
  const allLinks = await getLinks(base, page)
  const internalLinks = R.uniq(R.compose(
    R.map(R.curry(fixInternalLink)(base)(page)),
    R.filter(R.curry(isInternalLink)(base))
  )(
    allLinks
  ))
  return internalLinks
}

// Crawl for pages, starting with the base URL, and return all the pages found.
// The depth is how many levels deep to recurse.
// (String, String, Number) -> [String]
const crawl = async (base, depth = 2, currentPage = base) => {
  if (depth <= 0) return R.uniq([base, currentPage])

  const newPages = await getInternalLinks(base, currentPage)

  return R.compose(
    R.uniq,
    R.concat(newPages),
    R.flatten
  )(
    await Promise.all(newPages.map(page => crawl(base, depth - 1, page)))
  )
}

const linksFromSitemap = async sitemap => {
  const xml = (await axios(sitemap)).data
  const results = await xml2js.parseStringPromise(xml)
  if (!results.urlset || !results.urlset.url) return []
  return R.flatten(results.urlset.url.map(R.prop('loc')))
}

// Returns true if the page contains any links that begin with the target, otherwise false.
// (String, String, String) -> Boolean
const pageLinksTo = async (target, base, page) => R.any(R.startsWith(target))(
  await getLinks(base, page)
)

const usage = () => {
  console.log('Usage:\n')
  console.log('    node main.js --url=<website-or-sitemap> --links-to=<target-URL> [--depth=<number>]\n')
  console.log('For example, to scan for pages of https://crawler-test.com that include any links to http://robotto.org:\n')
  console.log('    node main.js --url=https://crawler-test.com/ --links-to=http://robotto.org/\n')
  console.log('    node main.js --url=https://crawler-test.com/ --links-to=http://robotto.org/ --depth=1\n')
  console.log('Default page scanning depth is 2.')
}

const pluralize = (singular, plural, n) => n === 1 ? singular : plural

const nullish = x => x === null || x === undefined

;(async () => {
  const argv = require('minimist')(process.argv.slice(2))

  if (!argv.url || !argv['links-to']) return usage()

  const [ base, target ] = [ argv.url, argv['links-to'] ]
  const depth = nullish(argv.depth) ? 2 : argv.depth

  const pages = (
    base.endsWith('.xml') ? await linksFromSitemap(base)
      : (
        console.log(`Scanning for pages (${depth} ${pluralize('level', 'levels', depth)} deep)...`),
        await crawl(base, depth)
      )
  )

  console.log(`Found ${pages.length} ${pluralize('page', 'pages', pages.length)} on ${base}\n`)
  
  console.log(`Scanning pages for links...`)

  const intermediate = await Promise.all(
    pages.map(async page => {
      const bool = await pageLinksTo(target, base, page)
      process.stdout.write('.')
      return {
        page,
        bool
      }
    })
  )
  console.log('\n')
  
  const results = R.compose(
    R.map(R.prop('page')),
    R.filter(R.propEq('bool', true))
  )(
    intermediate
  )

  console.log(`Found ${results.length} ${pluralize('page', 'pages', results.length)} that ${pluralize('links', 'link', results.length)} to ${target}${results.length === 0 ? '.' : ':'}\n`)
  results.forEach(result => console.log(result))

})();
