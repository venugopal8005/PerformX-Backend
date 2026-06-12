import cron from "node-cron";

const N8N_WEBHOOK_URL = "https://primary-production-dece4.up.railway.app/webhook/64c306e4-fa51-4179-b895-6fddfdce7305";

export function startN8NScheduler() {

    console.log(
        "N8N scheduler started"
    );

    // every 1 minute

    cron.schedule("* * * * *", async () => {

        try {

            console.log(
                "Triggering n8n webhook..."
            );

            const response = await fetch(
                N8N_WEBHOOK_URL,
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json",
                    },
                }
            );

            if (!response.ok) {

                throw new Error(
                    `Webhook failed: ${response.status}`
                );
            }

            console.log(
                "n8n webhook triggered successfully"
            );

        } catch (error) {

            console.error(
                "Scheduler error:",
                error.message
            );
        }
    });
}