import axios from 'axios';
import cheerio from 'cheerio';

const confluenceBaseUrl = 'https://gs24.atlassian.net/wiki/api/v2';
const confluenceUsername = 'oliver.schmitz@scout24.com';
const confluenceApiToken = '';

interface Page {
  parentType: string;
  parentId: string;
  spaceId: string;
  createdAt: string;
  status: string;
  body: {
    storage: {
      representation: string;
      value: string;
    }
  };
  title: string;
  id: string;
  _links: {
    webui: string;
    tinyui: string;
  };
}

async function fetchAllPages(spaceKey: string): Promise<Page[]> {
  const auth = Buffer.from(`${confluenceUsername}:${confluenceApiToken}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  try {
    const spaceIdResponse = await axios.get(`${confluenceBaseUrl}/spaces`, {
      headers,
      params: {
        keys: 'DOCI',
        limit: 10, // Adjust the limit as needed
      },
    });

    const spaceId = spaceIdResponse.data.results[0].id;
    console.log('SpaceId:', spaceId);

    const spaceResponse = await axios.get(`${confluenceBaseUrl}/pages`, {
      headers,
      params: {
        'space-id': spaceId,
        status: 'current',
        'body-format': 'storage',
        limit: 10 // Adjust the limit as needed
      },
    });
    const pages = spaceResponse.data.results;
    console.log('response data:', spaceResponse.data);
    console.log('Pages:', pages[0]._links.tinyui);
    console.log('storage:', pages[0].body.storage);

    // Extract text content from HTML snippet
    pages.forEach(page => {
      const $ = cheerio.load(page.body.storage.value);
      const textContent = $.text();
      console.log(`Text content for page ${page.id}:`, textContent);
    });

    return pages;
  } catch (error) {
    console.error('Error fetching pages:', error);
    throw error;
  }
}

// Example usage
fetchAllPages('DOCI').catch(console.error);