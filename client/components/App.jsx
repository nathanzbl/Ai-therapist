import { useEffect, useRef, useState } from "react";
import logo from "/assets/openai-logomark.svg";
import ChatLog from "./ChatLog";
import SessionControls from "./SessionControls";
import Header from './header';



export default function App() {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [events, setEvents] = useState([]);
  const [messages, setMessages] = useState([]);
  const [assistantStream, setAssistantStream] = useState("");
  const [localStream, setLocalStream] = useState(null);
  const assistantBuffer = useRef("");
  const userBuffer = useRef("");
  const currentVoiceMessageId = useRef(null);
  const [dataChannel, setDataChannel] = useState(null);
  const peerConnection = useRef(null);
  const audioElement = useRef(null);

  async function startSession() {
    const tokenResponse = await fetch("/token");
    const data = await tokenResponse.json();
    const EPHEMERAL_KEY = data.client_secret.value;

    const pc = new RTCPeerConnection();
    audioElement.current = document.createElement("audio");
    audioElement.current.autoplay = true;
    pc.ontrack = (e) => (audioElement.current.srcObject = e.streams[0]);

    const ms = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });
    setLocalStream(ms);
    pc.addTrack(ms.getTracks()[0]);

    const dc = pc.createDataChannel("oai-events");
    setDataChannel(dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const baseUrl = "https://api.openai.com/v1/realtime";
    const model = "gpt-4o-realtime-preview-2024-12-17";
    const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${EPHEMERAL_KEY}`,
        "Content-Type": "application/sdp",
      },
    });

    const answer = {
      type: "answer",
      sdp: await sdpResponse.text(),
    };
    await pc.setRemoteDescription(answer);

    peerConnection.current = pc;
  }

  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
    }

    peerConnection.current.getSenders().forEach((sender) => {
      if (sender.track) {
        sender.track.stop();
      }
    });

    if (peerConnection.current) {
      peerConnection.current.close();
    }

    setIsSessionActive(false);
    setDataChannel(null);
    setLocalStream(null);
    peerConnection.current = null;
  }

  function sendClientEvent(message) {
    if (dataChannel) {
      const timestamp = new Date().toLocaleTimeString();
      message.event_id = message.event_id || crypto.randomUUID();

      dataChannel.send(JSON.stringify(message));

      if (!message.timestamp) {
        message.timestamp = timestamp;
      }
      setEvents((prev) => [message, ...prev]);
    } else {
      console.error(
        "Failed to send message - no data channel available",
        message
      );
    }
  }

  function sendTextMessage(message) {
    const event = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: message,
          },
        ],
      },
    };

    sendClientEvent(event);
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", text: message },
    ]);
    sendClientEvent({ type: "response.create" });
  }

  useEffect(() => {
    if (dataChannel) {
      dataChannel.addEventListener("message", (e) => {
        const event = JSON.parse(e.data);
        if (!event.timestamp) {
          event.timestamp = new Date().toLocaleTimeString();
        }

        if (event.type && event.type.startsWith("response")) {
          if (event.response && event.response.output) {
            event.response.output.forEach((out) => {
              if (out.type === "text") {
                assistantBuffer.current += out.text;
                setAssistantStream(assistantBuffer.current.trim());
              }
            });
          }

          if (event.type === "response.done" && assistantBuffer.current) {
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                text: assistantBuffer.current.trim(),
              },
            ]);
            assistantBuffer.current = "";
            setAssistantStream("");
          }
        }


        if (event.type && event.type.startsWith("transcript")) {
          if (event.transcript && event.transcript.text) {
            if (!currentVoiceMessageId.current) {
              const id = crypto.randomUUID();
              currentVoiceMessageId.current = id;
              setMessages((prev) => [
                ...prev,
                { id, role: "user", text: "" },
              ]);
            }
            userBuffer.current += event.transcript.text;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === currentVoiceMessageId.current
                  ? { ...m, text: userBuffer.current.trim() }
                  : m,
              ),
            );
          }

          if (event.type === "transcript.done" && userBuffer.current) {
            currentVoiceMessageId.current = null;
            userBuffer.current = "";
            // request the assistant's reply after the user finishes speaking
            sendClientEvent({ type: "response.create" });
          }
        }

        setEvents((prev) => [event, ...prev]);
      });

      dataChannel.addEventListener("open", () => {
        setIsSessionActive(true);
        setEvents([]);
        setMessages([]);
        setAssistantStream("");
      });
    }
  }, [dataChannel]);

  return (
    <div className="flex flex-col min-h-screen">
      <Header /> 
      <main className="flex-1 flex flex-col items-center justify-between px-4 py-6 bg-gray-50">
        <div className="w-full max-w-4xl flex-1 overflow-y-auto">
          <ChatLog
            messages={messages}
            assistantStream={assistantStream}
          />
        </div>
        <div className="w-full max-w-4xl h-32 p-4">
          <SessionControls
            startSession={startSession}
            stopSession={stopSession}
            sendTextMessage={sendTextMessage}
            isSessionActive={isSessionActive}
            localStream={localStream}
          />
        </div>
      </main>
    </div>
  );
}  