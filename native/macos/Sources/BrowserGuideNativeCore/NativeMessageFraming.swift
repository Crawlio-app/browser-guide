import Foundation

public enum NativeMessageFramingError: Error, Equatable, Sendable {
    case emptyMessage
    case messageTooLarge(maximumBytes: Int)
    case truncatedFrame
}

/// Chrome native messaging uses a four-byte, little-endian unsigned length followed by UTF-8 JSON.
public struct NativeMessageFrameDecoder: Sendable {
    public static let defaultMaximumMessageBytes = 768 * 1_024

    private var buffer = Data()
    private var expectedPayloadLength: Int?
    private let maximumMessageBytes: Int

    public init(maximumMessageBytes: Int = Self.defaultMaximumMessageBytes) {
        precondition(maximumMessageBytes > 0 && maximumMessageBytes <= Int(UInt32.max))
        self.maximumMessageBytes = maximumMessageBytes
    }

    public mutating func append(_ bytes: Data) throws -> [Data] {
        buffer.append(bytes)
        var messages: [Data] = []

        while true {
            if expectedPayloadLength == nil {
                guard buffer.count >= MemoryLayout<UInt32>.size else { break }
                let header = Array(buffer.prefix(MemoryLayout<UInt32>.size))
                buffer.removeFirst(MemoryLayout<UInt32>.size)
                let length = UInt32(header[0])
                    | (UInt32(header[1]) << 8)
                    | (UInt32(header[2]) << 16)
                    | (UInt32(header[3]) << 24)
                guard length > 0 else { throw NativeMessageFramingError.emptyMessage }
                guard length <= UInt32(maximumMessageBytes) else {
                    throw NativeMessageFramingError.messageTooLarge(maximumBytes: maximumMessageBytes)
                }
                expectedPayloadLength = Int(length)
            }

            guard let length = expectedPayloadLength, buffer.count >= length else { break }
            messages.append(Data(buffer.prefix(length)))
            buffer.removeFirst(length)
            expectedPayloadLength = nil
        }

        return messages
    }

    public mutating func finish() throws {
        guard buffer.isEmpty && expectedPayloadLength == nil else {
            throw NativeMessageFramingError.truncatedFrame
        }
    }

    public static func encode(
        _ payload: Data,
        maximumMessageBytes: Int = Self.defaultMaximumMessageBytes
    ) throws -> Data {
        guard !payload.isEmpty else { throw NativeMessageFramingError.emptyMessage }
        guard payload.count <= maximumMessageBytes, payload.count <= Int(UInt32.max) else {
            throw NativeMessageFramingError.messageTooLarge(maximumBytes: maximumMessageBytes)
        }
        let length = UInt32(payload.count)
        var framed = Data(capacity: MemoryLayout<UInt32>.size + payload.count)
        framed.append(UInt8(truncatingIfNeeded: length))
        framed.append(UInt8(truncatingIfNeeded: length >> 8))
        framed.append(UInt8(truncatingIfNeeded: length >> 16))
        framed.append(UInt8(truncatingIfNeeded: length >> 24))
        framed.append(payload)
        return framed
    }
}
