**1000Jobs** is an intelligent automation tool designed to streamline the job application process on Lever-based platforms. By combining the power of local LLMs via **Ollama** and the stealth capabilities of the **Bright Data Browser API**, this application parses your CV, maps it to complex job forms, and handles everything from basic contact info to voluntary self-identification and custom screening questions. It aims to move beyond simple side projects to a production-ready strategy for high-volume, high-quality job applications.

---

## Setting up environment
Follow these steps to configure the application on your local machine:

1.  **Create a Workspace**: Create a new folder for the project and open it in your terminal.
2.  git clone "https://github.com/mohammad01ahmad/1000jobs.git"
3.  **Install Ollama**: Download the `.dmg` file for macOS from [ollama.com/download/mac](https://ollama.com/download/mac).
4.  **Run the Local Model**: Open your terminal and run the following command to start the LLM engine:
    ```bash ollama run llama3.1```
    *(Note: You can use other Llama models if required by your configuration)*.
5.  **Set up Bright Data**: Sign in to your account via the [Bright Data Portal](https://brightdata.com/?ps_partner_key=MDEzYjdiYzE5NDcw&ps_xid=ECBbAb2GH2EmF2&gsxid=ECBbAb2GH2EmF2&gspk=MDEzYjdiYzE5NDcw&utm_source=affiliates&utm_campaign=MDEzYjdiYzE5NDcw&gclid=CjwKCAjwntHPBhAaEiwA_Xp6Rq4h5lt5i_8tGXJ7L7fAAwzXcJYVHxBAHQ4Op6UoMiGHq1GUD33Q5BoCV64QAvD_BwE).
6.  **Configure Browser API**:
    *   Navigate to **Web Access** on the left-hand sidebar.
    *   Click **Create API**.
    *   Select **Browser API**.
    *   Copy your **API Key** and the **BrightData WebSocket URL** and save them securely.
7.  **Environment Variables**: In your IDE, create a `.env.local` file in the root directory and paste your credentials:
    ```env BRIGHTDATA_WS_URL='your_brightdata_link'```
---

## Running and Testing the System
Once the environment is configured, follow these steps to start applying:

1.  **Start the Application**: Run the following command in your terminal ```npm run dev```
2.  Paste your level job URL and CV and click Run
3.  If you want your application to not be submitted and just want to test the system check the 'Dry Run mode'
---
